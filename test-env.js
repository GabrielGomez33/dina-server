// Simple environment variable test
require('dotenv').config();

console.log('=== ENVIRONMENT VARIABLE TEST ===');
console.log('Working Directory:', process.cwd());
console.log('NODE_ENV:', process.env.NODE_ENV);
console.log('');

console.log('=== DATABASE VARIABLES ===');
console.log('DB_HOST:', process.env.DB_HOST || 'NOT SET');
console.log('DB_PORT:', process.env.DB_PORT || 'NOT SET');
console.log('DB_USER:', process.env.DB_USER || 'NOT SET');
console.log('DB_PASSWORD:', process.env.DB_PASSWORD ? '***SET***' : 'NOT SET');
console.log('DB_NAME:', process.env.DB_NAME || 'NOT SET');
console.log('');

console.log('=== SSL VARIABLES ===');
console.log('TUGRRPRIV:', process.env.TUGRRPRIV ? 'SET' : 'NOT SET');
console.log('TUGRRCERT:', process.env.TUGRRCERT ? 'SET' : 'NOT SET');
console.log('TUGRRINTERCERT:', process.env.TUGRRINTERCERT ? 'SET' : 'NOT SET');
console.log('');

console.log('=== OTHER VARIABLES ===');
console.log('DINA_PORT:', process.env.DINA_PORT || 'NOT SET');
console.log('REDIS_URL:', process.env.REDIS_URL || 'NOT SET');

console.log('\n=== RAW .env FILE CONTENT ===');
const fs = require('fs');
const path = require('path');

try {
    const envPath = path.join(process.cwd(), '.env');
    const envContent = fs.readFileSync(envPath, 'utf8');
    
    console.log('Found .env file at:', envPath);
    console.log('File content:');
    console.log('---START---');
    console.log(envContent);
    console.log('---END---');
} catch (error) {
    console.log('Error reading .env file:', error.message);
}
