const { PrismaClient } = require('@prisma/client');

// Correct Supabase pooler connection
const DATABASE_URL = "postgres://postgres.avvugheaifhfrskwcrlq:xVq5zl8JWji8EUoA@aws-1-ap-south-1.pooler.supabase.com:5432/postgres";

console.log('Connecting to Supabase...');

const prisma = new PrismaClient({
  datasources: {
    db: {
      url: DATABASE_URL
    }
  }
});

async function main() {
  try {
    console.log('Testing database connection...');

    // Test connection
    const result = await prisma.$queryRaw`SELECT 1 as test`;
    console.log('Connection OK');

    // Find all users
    const users = await prisma.user.findMany();
    console.log('Total users:', users.length);

    if (users.length > 0) {
      console.log('First user:', {
        email: users[0].email,
        role: users[0].role,
        hasPasswordHash: !!users[0].passwordHash
      });
    }

    // Find specific user
    const user = await prisma.user.findUnique({
      where: { email: 'a.sharaf@forcemediakw.com' }
    });
    console.log('Specific user found:', !!user);
    if (user) {
      console.log('User details:', {
        id: user.id,
        email: user.email,
        role: user.role,
        passwordHashLength: user.passwordHash?.length
      });
    }
  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    await prisma.$disconnect();
  }
}

main();
