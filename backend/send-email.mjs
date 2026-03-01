#!/usr/bin/env node
// Standalone email sender - reuses dashboard's email.config.json and nodemailer
// Usage: node tools/feature-dashboard/backend/send-email.mjs --subject "..." --body "..."

import nodemailer from 'nodemailer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, 'email.config.json');

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--subject' && argv[i + 1]) args.subject = argv[++i];
    else if (argv[i] === '--body' && argv[i + 1]) args.body = argv[++i];
  }
  return args;
}

async function main() {
  const { subject, body } = parseArgs(process.argv);
  if (!subject || !body) {
    console.error('Usage: send-email.mjs --subject "..." --body "..."');
    process.exit(1);
  }

  let config;
  try {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    console.error(`Config not found: ${CONFIG_PATH}`);
    process.exit(1);
  }

  if (!config.enabled || !config.user || !config.pass) {
    console.error('Email not configured. Set enabled/user/pass in email.config.json');
    process.exit(1);
  }

  const transporter = nodemailer.createTransport({
    host: config.smtpHost || 'smtp.gmail.com',
    port: config.smtpPort || 587,
    secure: false,
    auth: { user: config.user, pass: config.pass },
  });

  await transporter.sendMail({
    from: config.user,
    to: config.user,
    subject,
    text: body,
  });

  console.log(`Email sent: ${subject}`);
}

main().catch(err => {
  console.error(`Failed: ${err.message}`);
  process.exit(1);
});
