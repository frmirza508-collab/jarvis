import { z } from 'zod';

const Env = z.object({
  DATABASE_URL: z.string().min(1),
  LICENSE_SIGNING_PRIVATE_KEY: z.string().min(1),
  LICENSE_API_PORT: z.coerce.number().default(8787),
  LICENSE_API_HOST: z.string().default('0.0.0.0'),
  PUBLIC_BASE_URL: z.string().url().default('http://localhost:8787'),
  ADMIN_ORIGINS: z.string().default('http://localhost:5174'),
  TRUST_PROXY: z.enum(['true', 'false']).default('false'),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_PRICE_MONTHLY: z.string().optional(),
  STRIPE_PRICE_YEARLY: z.string().optional(),
  GATEWAY_WEBHOOK_SECRET: z.string().optional(),
  GATEWAY_CHECKOUT_URL: z.string().url().optional(),
});
export type Config = z.infer<typeof Env>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const c = Env.parse(env);
  return { ...c, LICENSE_SIGNING_PRIVATE_KEY: c.LICENSE_SIGNING_PRIVATE_KEY.replace(/\\n/g, '\n') };
}
