#!/usr/bin/env node

/**
 * Post-install script
 * Shows helpful setup instructions after npm install
 */

const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";
const GREEN = "\x1b[32m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

console.log(`
${CYAN}╔════════════════════════════════════════════════════════════════╗${RESET}
${CYAN}║${RESET}  ${BOLD}🤖 AI CLI Agent - Installation Complete${RESET}                        ${CYAN}║${RESET}
${CYAN}╚════════════════════════════════════════════════════════════════╝${RESET}

${BOLD}Quick Start (2 steps):${RESET}

${GREEN}1.${RESET} Run the setup wizard to configure your API key:
   ${GREEN}ai init${RESET}

${GREEN}2.${RESET} Ask your first question:
   ${GREEN}ai ask "hello, what can you do?"${RESET}

${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}

${YELLOW}⚠️  RECOMMENDED:${RESET} Initialize git in your project folders!

   The AI agent works best when your projects are git-initialized.
   This allows the agent to track your code changes with precise diffs.

${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}

${BOLD}Other Commands:${RESET}
   ${GREEN}ai setup${RESET}                       - Show all setup options
   ${GREEN}ai remember "important fact"${RESET}   - Save to memory
   ${GREEN}ai status${RESET}                      - Show current context
   ${GREEN}ai watch ~/code${RESET}                - Monitor file changes

${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}
`);
