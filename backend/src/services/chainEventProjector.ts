import {
  decodeEventLog,
  formatUnits,
  parseAbiItem,
  toEventSelector,
  type Address,
  type Hex,
} from "viem";
import { ARC_TESTNET_USDC, getChainId } from "../config/chain";
import { getDb, one, run } from "../db/database";
import { createDepositConfirmedNotification } from "./notifications";
import { recordServiceFailure, recordServiceSuccess } from "./serviceHealth";

const TIPPED_EVENT = parseAbiItem(
  "event Tipped(bytes32 indexed contentId, uint256 indexed authorId, address indexed from, address to, uint256 amount)"
);
const CLAIM_WALLET_DEPLOYED_EVENT = parseAbiItem(
  "event ClaimWalletDeployed(uint256 indexed authorId, address indexed wallet, address indexed owner)"
);
const TRANSFER_EVENT = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)"
);

const TIPPED_TOPIC = toEventSelector(TIPPED_EVENT).toLowerCase();
const CLAIM_TOPIC = toEventSelector(CLAIM_WALLET_DEPLOYED_EVENT).toLowerCase();
const TRANSFER_TOPIC = toEventSelector(TRANSFER_EVENT).toLowerCase();
const TIP_CONTRACT_ADDRESS = process.env.TIP_CONTRACT_ADDRESS?.toLowerCase();
const X_TIPPING_ROUTER_ADDRESS = process.env.X_TIPPING_ROUTER_ADDRESS?.toLowerCase();
const FACTORY_ADDRESS = process.env.FACTORY_ADDRESS?.toLowerCase();
const USDC_ADDRESS = (process.env.MOCK_USDC_ADDRESS || process.env.USDC_ADDRESS || ARC_TESTNET_USDC).toLowerCase();
const ARC_NATIVE_USDC_EVENT_ADDRESS = (process.env.ARC_NATIVE_USDC_EVENT_ADDRESS || "0x1800000000000000000000000000000000000000").toLowerCase();
const ARC_NATIVE_USDC_TRANSFER_TOPIC = (process.env.ARC_NATIVE_USDC_TRANSFER_TOPIC ||
  "0x62f084c00a442dcf51cdbb51beed2839bf42a268da8474b0e98f38edb7db5a22").toLowerCase();
const ARC_NATIVE_USDC_DECIMALS = Number(process.env.ARC_NATIVE_USDC_DECIMALS || "18");
const USDC_DECIMALS = Number(process.env.USDC_DECIMALS || "6");
const PROJECT_INTERVAL_MS = Math.max(250, Number(process.env.GOLDSKY_PROJECT_INTERVAL_MS || 1_000));
const PROJECT_BATCH_SIZE = Math.max(1, Math.min(1_000, Number(process.env.GOLDSKY_PROJECT_BATCH_SIZE || 100)));

type ChainLogRow = {
  id: string;
  chainId: number | string;
  address: string;
  topics: unknown;
  data: string;
  blockNumber: number | string;
  blockHash: string;
  transactionHash: string;
  logIndex: number | string;
  blockTimestamp: number | string | null;
  canonical: boolean;
};

export class ChainEventProjector {
  private running = false;
  private lastReconciliationAt = 0;

  async start(): Promise<void> {
    this.running = true;
    console.log(`[Goldsky] Starting DB projector every ${PROJECT_INTERVAL_MS}ms`);
    void this.loop();
  }

  stop(): void {
    this.running = false;
    console.log("[Goldsky] Projector stopped");
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        const projected = await this.projectBatch();
        if (Date.now() - this.lastReconciliationAt >= 60_000) {
          await reconcileRemovedEvents();
          this.lastReconciliationAt = Date.now();
        }
        if (projected > 0) await recordServiceSuccess("goldsky_projector", { projected });
      } catch (error) {
        console.error("[Goldsky] Projector error:", error);
        await recordServiceFailure("goldsky_projector", error).catch(() => {});
      }
      await sleep(PROJECT_INTERVAL_MS);
    }
  }

  private async projectBatch(): Promise<number> {
    const rows = await getDb().prepare(
      `SELECT l.id,
              l.chain_id as "chainId",
              l.address,
              l.topics,
              l.data,
              l.block_number as "blockNumber",
              l.block_hash as "blockHash",
              l.transaction_hash as "transactionHash",
              l.log_index as "logIndex",
              l.block_timestamp as "blockTimestamp",
              l.canonical
       FROM goldsky_ingest.chain_logs l
       LEFT JOIN chain_event_projections p ON p.event_id = l.id
       WHERE p.event_id IS NULL OR p.canonical <> l.canonical
       ORDER BY l.block_number, l.log_index
       LIMIT ?`
    ).all<ChainLogRow>(PROJECT_BATCH_SIZE);

    for (const row of rows) await this.project(row);
    return rows.length;
  }

  private async project(row: ChainLogRow): Promise<void> {
    const topics = normalizeTopics(row.topics);
    const topic0 = topics[0]?.toLowerCase() || "";
    const address = row.address.toLowerCase();
    const txHash = row.transactionHash.toLowerCase();
    const blockNumber = Number(row.blockNumber);
    const logIndex = Number(row.logIndex);

    if (!row.canonical) {
      await reverseProjection(row.id, txHash, logIndex);
      return;
    }

    let eventKind = "ignored";
    let entityKey: string | null = null;
    if (topic0 === TIPPED_TOPIC && (address === TIP_CONTRACT_ADDRESS || address === X_TIPPING_ROUTER_ADDRESS)) {
      const decoded = decodeEventLog({ abi: [TIPPED_EVENT], data: row.data as Hex, topics });
      const args = decoded.args as unknown as { contentId: Hex; authorId: bigint; from: Address; to: Address; amount: bigint };
      eventKind = "tip";
      entityKey = `${txHash}:${logIndex}`;
      await projectTip({
        contentId: args.contentId,
        authorId: args.authorId.toString(),
        from: args.from.toLowerCase(),
        to: args.to.toLowerCase(),
        amount: args.amount.toString(),
        txHash,
        blockNumber,
        logIndex,
        timestamp: normalizeTimestamp(row.blockTimestamp),
        contractAddress: address,
      });
    } else if (topic0 === CLAIM_TOPIC && address === FACTORY_ADDRESS) {
      const decoded = decodeEventLog({ abi: [CLAIM_WALLET_DEPLOYED_EVENT], data: row.data as Hex, topics });
      const args = decoded.args as unknown as { authorId: bigint; wallet: Address; owner: Address };
      eventKind = "claim_wallet";
      entityKey = txHash;
      await getDb().prepare(
        `INSERT INTO claim_wallets (author_id, wallet_address, owner_address, deployed_at_block, tx_hash)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (author_id) DO UPDATE SET
           wallet_address = excluded.wallet_address,
           owner_address = excluded.owner_address,
           deployed_at_block = excluded.deployed_at_block,
           tx_hash = excluded.tx_hash`
      ).run(args.authorId.toString(), args.wallet.toLowerCase(), args.owner.toLowerCase(), blockNumber, txHash);
    } else if (topic0 === TRANSFER_TOPIC && address === USDC_ADDRESS) {
      const decoded = decodeEventLog({ abi: [TRANSFER_EVENT], data: row.data as Hex, topics });
      const args = decoded.args as unknown as { from: Address; to: Address; value: bigint };
      if (await isKnownTeepAddress(args.to)) {
        eventKind = "funding";
        entityKey = `erc20_transfer:${txHash}:${logIndex}`;
        await projectFunding({
          id: entityKey,
          from: args.from.toLowerCase(),
          to: args.to.toLowerCase(),
          amountRaw: args.value,
          decimals: USDC_DECIMALS,
          txHash,
          blockNumber,
          logIndex,
          timestamp: normalizeTimestampMs(row.blockTimestamp),
          source: "erc20_transfer",
        });
      }
    } else if (topic0 === ARC_NATIVE_USDC_TRANSFER_TOPIC && address === ARC_NATIVE_USDC_EVENT_ADDRESS) {
      const to = topicToAddress(topics[2]);
      if (to && await isKnownTeepAddress(to)) {
        eventKind = "funding";
        entityKey = `arc_native_transfer:${txHash}:${logIndex}`;
        await projectFunding({
          id: entityKey,
          from: topicToAddress(topics[1]) || "",
          to,
          amountRaw: BigInt(row.data || "0x0"),
          decimals: ARC_NATIVE_USDC_DECIMALS,
          txHash,
          blockNumber,
          logIndex,
          timestamp: normalizeTimestampMs(row.blockTimestamp),
          source: "arc_native_transfer",
        });
      }
    }

    await run(
      `INSERT INTO chain_event_projections (
         event_id, event_kind, entity_key, block_number, canonical, projected_at, error
       ) VALUES (?, ?, ?, ?, TRUE, ?, NULL)
       ON CONFLICT (event_id) DO UPDATE SET
         event_kind = excluded.event_kind,
         entity_key = excluded.entity_key,
         block_number = excluded.block_number,
         canonical = TRUE,
         projected_at = excluded.projected_at,
         error = NULL`,
      [row.id, eventKind, entityKey, blockNumber, Date.now()]
    );
  }
}

async function projectTip(input: {
  contentId: string; authorId: string; from: string; to: string; amount: string;
  txHash: string; blockNumber: number; logIndex: number; timestamp: number; contractAddress: string;
}) {
  await getDb().prepare(
    `INSERT INTO tips (
       content_id, author_id, from_address, to_address, amount, tx_hash,
       block_number, log_index, timestamp, tip_contract_address
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (tx_hash) DO NOTHING`
  ).run(
    input.contentId, input.authorId, input.from, input.to, input.amount, input.txHash,
    input.blockNumber, input.logIndex, input.timestamp, input.contractAddress
  );
}

async function projectFunding(input: {
  id: string; from: string; to: string; amountRaw: bigint; decimals: number; txHash: string;
  blockNumber: number; logIndex: number; timestamp: number; source: "erc20_transfer" | "arc_native_transfer";
}) {
  if (!input.to || input.from === input.to) return;
  const amount = formatUnits(input.amountRaw, input.decimals);
  const amountRawUsdc = input.decimals === 6
    ? input.amountRaw.toString()
    : (input.amountRaw / 10n ** BigInt(input.decimals - 6)).toString();
  const changes = await run(
    `INSERT INTO funding_provider_sessions (
       id, provider, provider_session_id, kind, user_address, status,
       redirect_url, metadata_json, created_at, updated_at
     ) VALUES (?, 'Arc USDC', ?, 'crypto_receive', ?, 'completed', NULL, ?, ?, ?)
     ON CONFLICT (id) DO NOTHING`,
    [
      input.id,
      `${input.txHash}:${input.logIndex}`,
      input.to,
      JSON.stringify({
        amount,
        amountRaw: amountRawUsdc,
        chainAmountRaw: input.amountRaw.toString(),
        asset: "USDC",
        txHash: input.txHash,
        from: input.from,
        blockNumber: input.blockNumber,
        logIndex: input.logIndex,
        source: input.source,
      }),
      input.timestamp,
      Date.now(),
    ]
  );
  if (changes > 0) {
    await createDepositConfirmedNotification({ userAddress: input.to, amountRaw: amountRawUsdc, txHash: input.txHash });
  }
}

async function reverseProjection(eventId: string, txHash: string, logIndex: number) {
  const projection = await one<{ eventKind: string; entityKey: string | null }>(
    `SELECT event_kind as "eventKind", entity_key as "entityKey"
     FROM chain_event_projections WHERE event_id = ?`,
    [eventId]
  );
  if (projection?.eventKind === "tip") {
    await run("DELETE FROM tips WHERE LOWER(tx_hash) = ? AND log_index = ?", [txHash, logIndex]);
  } else if (projection?.eventKind === "claim_wallet") {
    await run("DELETE FROM claim_wallets WHERE LOWER(tx_hash) = ?", [txHash]);
  } else if (projection?.eventKind === "funding" && projection.entityKey) {
    await run("DELETE FROM funding_provider_sessions WHERE id = ?", [projection.entityKey]);
  }
  await run(
    `UPDATE chain_event_projections
     SET canonical = FALSE, projected_at = ?, error = NULL
     WHERE event_id = ?`,
    [Date.now(), eventId]
  );
}

async function reconcileRemovedEvents() {
  const removed = await getDb().prepare(
    `SELECT p.event_id as "eventId", p.event_kind as "eventKind", p.entity_key as "entityKey"
     FROM chain_event_projections p
     LEFT JOIN goldsky_ingest.chain_logs l ON l.id = p.event_id
     WHERE p.canonical = TRUE AND l.id IS NULL
     ORDER BY p.block_number DESC
     LIMIT 100`
  ).all<{ eventId: string; eventKind: string; entityKey: string | null }>();
  for (const projection of removed) {
    if (projection.eventKind === "tip" && projection.entityKey) {
      const [txHash, logIndex] = projection.entityKey.split(":");
      await run("DELETE FROM tips WHERE LOWER(tx_hash) = ? AND log_index = ?", [txHash, Number(logIndex)]);
    } else if (projection.eventKind === "funding" && projection.entityKey) {
      await run("DELETE FROM funding_provider_sessions WHERE id = ?", [projection.entityKey]);
    } else if (projection.eventKind === "claim_wallet" && projection.entityKey) {
      await run("DELETE FROM claim_wallets WHERE LOWER(tx_hash) = ?", [projection.entityKey]);
    }
    await run(
      "UPDATE chain_event_projections SET canonical = FALSE, projected_at = ? WHERE event_id = ?",
      [Date.now(), projection.eventId]
    );
  }
}

async function isKnownTeepAddress(address: string): Promise<boolean> {
  const normalized = address.toLowerCase();
  const row = await one<{ found: number }>(
    `SELECT 1 as found FROM (
       SELECT user_address as address FROM x_accounts
       UNION ALL SELECT address FROM user_settings
       UNION ALL SELECT owner_address as address FROM verified_claims
       UNION ALL SELECT wallet_address as address FROM claim_wallets
     ) known WHERE LOWER(known.address) = ? LIMIT 1`,
    [normalized]
  );
  return Boolean(row);
}

function normalizeTopics(value: unknown): [] | [Hex, ...Hex[]] {
  let topics: Hex[] = [];
  if (Array.isArray(value)) topics = value.map(String) as Hex[];
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) topics = parsed.map(String) as Hex[];
    } catch {
      topics = value.split(",").map((topic) => topic.trim()).filter(Boolean) as Hex[];
    }
  }
  return topics.length > 0 ? topics as [Hex, ...Hex[]] : [];
}

function topicToAddress(topic?: Hex): string | null {
  return topic ? `0x${topic.slice(-40)}`.toLowerCase() : null;
}

function normalizeTimestamp(value: number | string | null): number {
  if (value == null) return Math.floor(Date.now() / 1000);
  const timestamp = Number(value);
  return timestamp > 10_000_000_000 ? Math.floor(timestamp / 1000) : timestamp;
}

function normalizeTimestampMs(value: number | string | null): number {
  if (value == null) return Date.now();
  const timestamp = Number(value);
  return timestamp > 10_000_000_000 ? timestamp : timestamp * 1000;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
