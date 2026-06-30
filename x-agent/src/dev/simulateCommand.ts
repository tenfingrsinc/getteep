import * as dotenv from "dotenv";
import { processPostOnBackend } from "../client/teepBackend";
import { config } from "../config";
import type { XIncomingPost } from "../parser/commandTypes";
import { parseTipCommand } from "../parser/parseTipCommand";

dotenv.config();

type CliOptions = {
  text?: string;
  tweetId: string;
  authorId: string;
  authorUsername?: string;
  parentTweetId?: string;
  parentAuthorId?: string;
  parentAuthorUsername?: string;
  parseOnly: boolean;
};

function usage() {
  return [
    "Usage:",
    "  npm run simulate -- \"@teep_app tip @alice $5\"",
    "  npm run simulate -- \"@teep_app tip this post $5\" --parent-author-id 100000002 --parent-author sample_creator",
    "  npm run simulate -- \"@teep_app balance\" --author-id 100000001 --author bob",
    "",
    "PowerShell note: use single quotes or escape dollar signs, e.g.",
    "  npm run simulate -- '@teep_app tip @alice $5'",
    "",
    "Options:",
    "  --tweet-id <id>              Override simulated source tweet id",
    "  --author-id <id>             Simulated sender X user id",
    "  --author <username>          Simulated sender username",
    "  --parent-tweet-id <id>       Simulated parent/source post id",
    "  --parent-author-id <id>      Simulated parent creator X user id",
    "  --parent-author <username>   Simulated parent creator username",
    "  --parse-only                 Only print local parser output; do not call backend",
    "  --help                       Show this help",
    "",
    "Environment:",
    "  TEEP_BACKEND_URL             Defaults to http://localhost:3001",
    "  X_AGENT_TOKEN                Required unless --parse-only is used",
    "  X_SIM_AUTHOR_ID              Default simulated sender id",
    "  X_SIM_AUTHOR_USERNAME        Default simulated sender username",
    "  X_SIM_PARENT_AUTHOR_ID       Default parent author id",
    "  X_SIM_PARENT_AUTHOR_USERNAME Default parent author username",
  ].join("\n");
}

function env(name: string, fallback = "") {
  return (process.env[name] || fallback).trim();
}

function nextArg(args: string[], index: number, name: string) {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function makeSimulatedId() {
  const now = Date.now().toString();
  return `9${now.padStart(18, "0").slice(-18)}`;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    tweetId: makeSimulatedId(),
    authorId: env("X_SIM_AUTHOR_ID", "100000001"),
    authorUsername: env("X_SIM_AUTHOR_USERNAME", "teep_tester"),
    parentTweetId: undefined,
    parentAuthorId: env("X_SIM_PARENT_AUTHOR_ID"),
    parentAuthorUsername: env("X_SIM_PARENT_AUTHOR_USERNAME"),
    parseOnly: false,
  };

  const textParts: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--help":
      case "-h":
        console.log(usage());
        process.exit(0);
      case "--tweet-id":
        options.tweetId = nextArg(argv, index, arg);
        index += 1;
        break;
      case "--author-id":
        options.authorId = nextArg(argv, index, arg);
        index += 1;
        break;
      case "--author":
      case "--author-username":
        options.authorUsername = nextArg(argv, index, arg).replace(/^@/, "");
        index += 1;
        break;
      case "--parent-tweet-id":
        options.parentTweetId = nextArg(argv, index, arg);
        index += 1;
        break;
      case "--parent-author-id":
        options.parentAuthorId = nextArg(argv, index, arg);
        index += 1;
        break;
      case "--parent-author":
      case "--parent-author-username":
        options.parentAuthorUsername = nextArg(argv, index, arg).replace(/^@/, "");
        index += 1;
        break;
      case "--parse-only":
        options.parseOnly = true;
        break;
      default:
        textParts.push(arg);
        break;
    }
  }

  options.text = textParts.join(" ").trim();
  if (!options.text) {
    throw new Error("A command text argument is required.\n\n" + usage());
  }
  return options;
}

function buildPost(options: CliOptions): XIncomingPost {
  return {
    id: options.tweetId,
    text: options.text || "",
    authorId: options.authorId,
    authorUsername: options.authorUsername,
    conversationId: options.parentTweetId || options.tweetId,
    parentTweetId: options.parentTweetId || undefined,
    parentAuthorId: options.parentAuthorId || undefined,
    parentAuthorUsername: options.parentAuthorUsername || undefined,
  };
}

async function main() {
  if (process.env.NODE_ENV === "production") {
    throw new Error("The x-agent simulator is dev-only and is disabled in NODE_ENV=production.");
  }

  const options = parseArgs(process.argv.slice(2));
  const post = buildPost(options);
  const parsed = parseTipCommand(post.text);

  console.log("[x-agent:simulate] Parsed command:");
  console.log(JSON.stringify(parsed, null, 2));
  console.log("");
  console.log("[x-agent:simulate] Simulated post:");
  console.log(JSON.stringify(post, null, 2));

  if (options.parseOnly) {
    return;
  }

  if (!config.agentToken) {
    throw new Error("X_AGENT_TOKEN is required to call the backend. Use --parse-only to test parsing only.");
  }

  console.log("");
  console.log(`[x-agent:simulate] Calling ${config.backendUrl}/internal/x-bot/process-post`);
  const result = await processPostOnBackend(post);
  console.log("");
  console.log("[x-agent:simulate] Backend result:");
  console.log(JSON.stringify(result, null, 2));
  if (result.replyText) {
    console.log("");
    console.log("[x-agent:simulate] Reply text:");
    console.log(result.replyText);
  }
}

main().catch((err: unknown) => {
  console.error("[x-agent:simulate] Failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
