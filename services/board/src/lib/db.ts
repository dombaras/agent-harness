import { PrismaClient } from "@/generated/client/client";
import { Pool, type PoolConfig } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";

const globalForPrisma = globalThis as unknown as {
  boardPrisma: PrismaClient | undefined;
  boardPool: Pool | undefined;
};

function poolConfigFor(url: string): PoolConfig {
  return {
    connectionString: url,
    max: process.env.DB_POOL_MAX ? parseInt(process.env.DB_POOL_MAX, 10) : 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    ssl: url.includes("sslmode=require") ? { rejectUnauthorized: false } : undefined,
  };
}

function createClient(url: string): PrismaClient {
  const pool = new Pool(poolConfigFor(url));
  return new PrismaClient({ adapter: new PrismaPg(pool) });
}

export function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  return url;
}

export const prisma = globalForPrisma.boardPrisma ?? createClient(databaseUrl());

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.boardPrisma = prisma;
}
