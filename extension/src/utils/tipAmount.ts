import { formatUnits, parseUnits } from "viem";
import { CONFIG } from "./config";

const DECIMAL_AMOUNT = /^(?:0|[1-9]\d*)(?:\.(\d{1,6}))?$/;

export type ParsedTipAmount = {
  display: string;
  raw: bigint;
};

function trimDecimal(value: string) {
  if (!value.includes(".")) return value;
  return value.replace(/0+$/, "").replace(/\.$/, "");
}

export function parseTipAmount(value: string): ParsedTipAmount {
  const input = value.trim();
  if (!DECIMAL_AMOUNT.test(input)) {
    throw new Error("Enter a valid amount with up to 6 decimal places.");
  }

  const raw = parseUnits(input, CONFIG.USDC_DECIMALS);
  const minimum = parseUnits(String(CONFIG.MIN_TIP_USDC), CONFIG.USDC_DECIMALS);
  const maximum = parseUnits(String(CONFIG.MAX_TIP_USDC), CONFIG.USDC_DECIMALS);

  if (raw < minimum) {
    throw new Error(`Minimum tip is $${CONFIG.MIN_TIP_USDC}.`);
  }
  if (raw > maximum) {
    throw new Error(`Maximum tip is $${CONFIG.MAX_TIP_USDC.toLocaleString()}.`);
  }

  return {
    display: trimDecimal(formatUnits(raw, CONFIG.USDC_DECIMALS)),
    raw,
  };
}
