import { tool } from "@opencode-ai/plugin"

const COOLDOWN_MS = Number(process.env.KEY_COOLDOWN_MS || 60000)
const ACCOUNTS = 5
const cooldowns: Record<string, number> = {}
let switches = 0

function mask(value: string): string {
  if (!value) return ""
  if (value.length <= 8) return "*".repeat(value.length)
  return `${value.slice(0, 4)}...${value.slice(-4)}`
}

export default tool({
  description:
    "Return the next available DeepSeek account slot from the 5-account pool. " +
    "Never exposes the raw API key (only env var name + masked preview). " +
    "Pass rate_limited_account when an account returned HTTP 429 so it is cooled down and the next account is selected.",
  args: {
    rate_limited_account: tool.schema
      .number()
      .optional()
      .describe("1-based account number that hit HTTP 429; it will be cooled down"),
  },
  async execute(args) {
    if (args.rate_limited_account) {
      const env = `DEEPSEEK_KEY_${args.rate_limited_account}`
      cooldowns[env] = Date.now() + COOLDOWN_MS
      switches += 1
    }
    const now = Date.now()
    const keys = Array.from({ length: ACCOUNTS }, (_, i) => {
      const env = `DEEPSEEK_KEY_${i + 1}`
      const value = process.env[env] || ""
      return {
        account: i + 1,
        env,
        present: Boolean(value),
        masked: mask(value),
        cooling_ms: Math.max(0, (cooldowns[env] || 0) - now),
      }
    })
    const available = keys.filter((k) => k.present && k.cooling_ms === 0)
    if (!available.length) {
      return JSON.stringify(
        {
          exhausted: true,
          retry_in_ms: Math.min(...keys.map((k) => k.cooling_ms).filter((ms) => ms > 0)),
          key_switches_total: switches,
          keys,
        },
        null,
        2,
      )
    }
    const chosen = available[0]
    return JSON.stringify(
      {
        account: chosen.account,
        env: chosen.env,
        masked: chosen.masked,
        key_switches_total: switches,
        keys,
      },
      null,
      2,
    )
  },
})
