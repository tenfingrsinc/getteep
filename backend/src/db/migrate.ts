import * as dotenv from "dotenv";
dotenv.config();

import { initDb } from "./database";

async function main() {
  console.log("Running database migration...");
  await initDb();
  console.log("Migration complete.");
}

main().catch((error) => {
  console.error("Migration failed:", error);
  process.exit(1);
});
