// Test fixture with insecure code patterns for SAST testing
// This file contains intentional security anti-patterns for testing

const fs = require('fs');
const child_process = require('child_process');

// INSECURE: Command injection via exec with user input
function runCommand(userInput) {
  child_process.exec(`ls ${userInput}`, (err, stdout, stderr) => {
    if (err) console.error(err);
    console.log(stdout);
  });
}

// INSECURE: Path traversal via unsanitized file path
function readFile(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

// INSECURE: Hardcoded credential
const API_KEY = "sk-1234567890abcdef";
const DB_PASSWORD = "admin123";

// INSECURE: eval with user input
function evaluate(input) {
  return eval(input);
}

// INSECURE: innerHTML assignment (XSS)
function setContent(element, content) {
  element.innerHTML = content;
}

module.exports = { runCommand, readFile, evaluate, setContent, API_KEY, DB_PASSWORD };
