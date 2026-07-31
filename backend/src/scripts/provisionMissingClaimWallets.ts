import "dotenv/config";
import { getDb } from "../db/database";
import { AttestationService } from "../services/attestation";
import {
  getClaimWalletProvisioningStatus,
  isClaimWalletProvisioningConfigured,
  provisionClaimWallet,
} from "../services/claimWalletProvisioner";

type ClaimRow = {
  author_id: string;
  owner_address: string;
  username: string;
};

async function main() {
  const execute = process.argv.includes("--execute");
  const limit = Math.min(500, Math.max(1, Number(process.env.CLAIM_WALLET_BACKFILL_LIMIT || 25) || 25));
  if (!isClaimWalletProvisioningConfigured()) {
    throw new Error("FACTORY_ADDRESS and a claim-wallet deployer private key are required");
  }

  const rows = await getDb().prepare(
    `SELECT DISTINCT ON (author_id) author_id, owner_address, username
     FROM verified_claims
     WHERE author_id ~ '^[0-9]+$'
     ORDER BY author_id, verified_at DESC
     LIMIT ?`
  ).all(limit) as ClaimRow[];
  const attestationService = new AttestationService();
  let missing = 0;
  let provisioned = 0;

  console.log(`[ClaimWalletBackfill] ${execute ? "EXECUTE" : "DRY RUN"}; checking up to ${limit} verified creators`);
  for (const row of rows) {
    const status = await getClaimWalletProvisioningStatus(row.author_id);
    if (status.deployed) continue;
    missing += 1;
    console.log(`[ClaimWalletBackfill] Missing: @${row.username} (${row.author_id}) -> ${status.walletAddress}`);
    if (!execute) continue;

    const attestation = await attestationService.createAttestation(row.author_id, row.owner_address);
    const result = await provisionClaimWallet({
      authorId: row.author_id,
      ownerAddress: row.owner_address,
      attestation,
    });
    if (!result.deployed) throw new Error(`Provisioning was not completed for author ${row.author_id}`);
    provisioned += 1;
  }

  console.log(`[ClaimWalletBackfill] Complete: ${missing} missing, ${provisioned} provisioned`);
  if (!execute && missing > 0) {
    console.log("[ClaimWalletBackfill] Re-run with --execute after reviewing this list.");
  }
}

main().catch((error) => {
  console.error("[ClaimWalletBackfill] Failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
