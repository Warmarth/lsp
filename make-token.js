// Make a test token without Flask:  node make-token.js <userId> [expiresIn]
// Examples: node make-token.js 1      node make-token.js 2 1h      node make-token.js 3 -10s  (already expired)
const path = require("node:path");
try {
  process.loadEnvFile(path.join(__dirname, ".env"));
} catch {}
const jwt = require("jsonwebtoken");

const [id = "1", expiresIn = "1h"] = process.argv.slice(2);
const payload = { sub: id, type: "access" };
const options = { algorithm: "HS256" };

if (expiresIn.startsWith("-")) {
  payload.exp = Math.floor(Date.now() / 1000) + parseInt(expiresIn, 10); // in the past
} else {
  options.expiresIn = expiresIn;
}
console.log(jwt.sign(payload, process.env.JWT_SECRET_KEY, options));
