import path from 'path';
import dotenv from 'dotenv';
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });
import { prisma } from '../packages/database/src/client';

async function main() {
  const invs = await prisma.invoice.findMany({
    where: { status: { in: ['READY', 'TO_REVIEW', 'NEW'] } },
    include: { files: true, lines: { take: 2 } },
    orderBy: { status: 'asc' },
  });
  for (const i of invs) {
    const fname = i.files[0]?.path.replace(/\\/g, '/').split('/').pop() ?? 'no-file';
    console.log(`[${i.status}] ${i.docNumberPa} | cardcode:${i.supplierB1Cardcode} | lines:${i.lines.length} | files:${i.files.length} → ${fname}`);
  }
  const settings = await prisma.setting.findMany();
  console.log('\n=== Settings ===');
  for (const s of settings) {
    console.log(`  ${s.key} = ${JSON.stringify(s.value)}`);
  }
  await prisma.$disconnect();
}
main().catch(e => { console.error(e.message); process.exit(1); });
