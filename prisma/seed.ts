import 'dotenv/config';
import { createPrismaClient } from '@/lib/prisma-client';
import { seedDatabase } from './seed-data';

async function main() {
  const prisma = createPrismaClient();
  try {
    await seedDatabase(prisma);
    console.log('Seeded.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
