// generate-password-hash.js
// Run this once to generate the ADMIN_PASSWORD_HASH value for your .env file.
//
// Usage:
//   node generate-password-hash.js "your-chosen-password"

const bcrypt = require('bcryptjs');

const password = process.argv[2];
console.log('Generating hash for password:', password);
if (!password) {
  console.error('Usage: node generate-password-hash.js "your-chosen-password"');
  process.exit(1);
}

const hash = bcrypt.hashSync(password, 10);
console.log('\nAdd this to your .env file:\n');
console.log(`ADMIN_PASSWORD_HASH=${hash}\n`);
