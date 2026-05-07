import { PrismaClient } from '@prisma/client';

export function installSqliteBigIntIdMiddleware(client: PrismaClient) {
  client.$use(async (params, next) => {
    return next(params);
  });
}
