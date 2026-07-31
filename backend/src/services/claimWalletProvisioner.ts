import { createWalletClient, parseAbi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { getConfiguredChain, getRpcUrl } from "../config/chain";
import { getDb } from "../db/database";
import { isAddress } from "../utils/security";
import type { Attestation } from "./attestation";
import { createBackendHttpTransport, createBackendPublicClient } from "./rpcClient";

const FACTORY_ABI = parseAbi([
  "function isDeployed(uint256 authorId) view returns (bool)",
  "function computeClaimWallet(uint256 authorId) view returns (address)",
  "function deployClaimWallet(uint256 authorId, address owner, uint256 timestamp, bytes32 nonce, bytes signature) returns (address)",
]);
const CLAIM_WALLET_ABI = parseAbi(["function owner() view returns (address)"]);

function factoryAddress(): `0x${string}` | null {
  const value = process.env.FACTORY_ADDRESS;
  return value && isAddress(value) ? (value as `0x${string}`) : null;
}

function deployerPrivateKey(): `0x${string}` | null {
  const value = process.env.CLAIM_WALLET_DEPLOYER_PRIVATE_KEY || process.env.X_TIPPING_RELAYER_PRIVATE_KEY;
  return value && /^0x[a-fA-F0-9]{64}$/.test(value) ? (value as `0x${string}`) : null;
}

export function isClaimWalletProvisioningConfigured(): boolean {
  return Boolean(factoryAddress() && deployerPrivateKey());
}

async function currentFactoryWallet(authorId: string) {
  const factory = factoryAddress();
  if (!factory) throw new Error("FACTORY_ADDRESS_NOT_CONFIGURED");
  const client = createBackendPublicClient();
  const authorIdValue = BigInt(authorId);
  const [deployed, walletAddress] = await Promise.all([
    client.readContract({ address: factory, abi: FACTORY_ABI, functionName: "isDeployed", args: [authorIdValue] }),
    client.readContract({ address: factory, abi: FACTORY_ABI, functionName: "computeClaimWallet", args: [authorIdValue] }),
  ]);
  const normalizedWallet = walletAddress.toLowerCase() as `0x${string}`;
  const ownerAddress = deployed
    ? await client.readContract({ address: normalizedWallet, abi: CLAIM_WALLET_ABI, functionName: "owner" })
    : null;
  return {
    deployed,
    walletAddress: normalizedWallet,
    ownerAddress: ownerAddress?.toLowerCase() as `0x${string}` | null,
  };
}

export async function getClaimWalletProvisioningStatus(authorId: string) {
  if (!/^\d+$/.test(authorId)) throw new Error("INVALID_CLAIM_WALLET_AUTHOR_ID");
  return currentFactoryWallet(authorId);
}

async function recordDeployment(params: {
  authorId: string;
  ownerAddress: string;
  walletAddress: string;
  blockNumber: bigint;
  txHash: string;
}) {
  const db = getDb();
  await db.transaction(async (txDb) => {
    const existing = await txDb
      .prepare("SELECT wallet_address FROM claim_wallets WHERE author_id = ? LIMIT 1")
      .get(params.authorId) as { wallet_address: string } | undefined;
    if (existing?.wallet_address && existing.wallet_address.toLowerCase() !== params.walletAddress.toLowerCase()) {
      await txDb.prepare(
        `INSERT INTO claim_wallet_legacy (author_id, wallet_address)
         VALUES (?, ?)
         ON CONFLICT(author_id, wallet_address) DO NOTHING`
      ).run(params.authorId, existing.wallet_address.toLowerCase());
    }
    await txDb.prepare(
      `INSERT INTO claim_wallets (author_id, wallet_address, owner_address, deployed_at_block, tx_hash)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(author_id) DO UPDATE SET
         wallet_address = excluded.wallet_address,
         owner_address = excluded.owner_address,
         deployed_at_block = excluded.deployed_at_block,
         tx_hash = excluded.tx_hash`
    ).run(
      params.authorId,
      params.walletAddress.toLowerCase(),
      params.ownerAddress.toLowerCase(),
      params.blockNumber.toString(),
      params.txHash.toLowerCase(),
    );
  })();
}

export async function provisionClaimWallet(params: {
  authorId: string;
  ownerAddress: string;
  attestation: Attestation;
}) {
  if (!/^\d+$/.test(params.authorId) || !isAddress(params.ownerAddress)) {
    throw new Error("INVALID_CLAIM_WALLET_IDENTITY");
  }
  if (params.attestation.authorId !== params.authorId || params.attestation.owner.toLowerCase() !== params.ownerAddress.toLowerCase()) {
    throw new Error("CLAIM_WALLET_ATTESTATION_MISMATCH");
  }

  const factory = factoryAddress();
  const privateKey = deployerPrivateKey();
  if (!factory || !privateKey) return { configured: false as const, deployed: false as const, walletAddress: null, txHash: null };

  const existing = await currentFactoryWallet(params.authorId);
  if (existing.deployed) {
    if (existing.ownerAddress !== params.ownerAddress.toLowerCase()) {
      throw new Error("CLAIM_WALLET_OWNER_MISMATCH");
    }
    return { configured: true as const, deployed: true as const, walletAddress: existing.walletAddress, txHash: null };
  }

  const account = privateKeyToAccount(privateKey);
  const publicClient = createBackendPublicClient();
  const walletClient = createWalletClient({
    account,
    chain: getConfiguredChain(),
    transport: createBackendHttpTransport(getRpcUrl()),
  });
  const args = [
    BigInt(params.authorId),
    params.ownerAddress as `0x${string}`,
    BigInt(params.attestation.timestamp),
    params.attestation.nonce as Hex,
    params.attestation.signature as Hex,
  ] as const;

  try {
    const simulation = await publicClient.simulateContract({
      account,
      address: factory,
      abi: FACTORY_ABI,
      functionName: "deployClaimWallet",
      args,
    });
    const txHash = await walletClient.writeContract(simulation.request);
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success") throw new Error("CLAIM_WALLET_DEPLOYMENT_REVERTED");
    const deployed = await currentFactoryWallet(params.authorId);
    if (!deployed.deployed) throw new Error("CLAIM_WALLET_DEPLOYMENT_NOT_RECORDED");
    await recordDeployment({
      authorId: params.authorId,
      ownerAddress: params.ownerAddress,
      walletAddress: deployed.walletAddress,
      blockNumber: receipt.blockNumber,
      txHash,
    });
    return { configured: true as const, deployed: true as const, walletAddress: deployed.walletAddress, txHash };
  } catch (error) {
    // Another request may have won the deployment race. Treat the factory as
    // authoritative before surfacing a failure.
    const afterFailure = await currentFactoryWallet(params.authorId).catch(() => null);
    if (afterFailure?.deployed && afterFailure.ownerAddress === params.ownerAddress.toLowerCase()) {
      return { configured: true as const, deployed: true as const, walletAddress: afterFailure.walletAddress, txHash: null };
    }
    throw error;
  }
}

export async function claimWalletBelongsToOwner(ownerAddress: string, claimWalletAddress: string): Promise<boolean> {
  const owner = ownerAddress.toLowerCase();
  const wallet = claimWalletAddress.toLowerCase();
  if (!isAddress(owner) || !isAddress(wallet)) return false;

  const db = getDb();
  const claim = await db.prepare(
    `SELECT author_id FROM verified_claims WHERE LOWER(owner_address) = ? ORDER BY verified_at DESC LIMIT 1`
  ).get(owner) as { author_id: string } | undefined;

  if (claim && factoryAddress()) {
    try {
      const current = await currentFactoryWallet(claim.author_id);
      return Boolean(current.deployed && current.walletAddress === wallet && current.ownerAddress === owner);
    } catch {
      // An RPC outage should not invalidate an indexed deployment below.
    }
  }

  const indexed = await db.prepare(
    `SELECT 1 as found FROM claim_wallets
     WHERE LOWER(owner_address) = ? AND LOWER(wallet_address) = ?
     LIMIT 1`
  ).get(owner, wallet) as { found: number } | undefined;
  return Boolean(indexed);
}
