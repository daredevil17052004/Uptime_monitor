const { PrismaClient } = require('@prisma/client');

// Singleton pattern — prevents creating multiple Prisma connections
// during hot-reloads in development (nodemon).
const prisma = new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
});

module.exports = prisma;
