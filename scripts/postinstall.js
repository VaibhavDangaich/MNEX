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

${YELLOW}⚠️  RECOMMENDED:${RESET} Initialize git in your project folders!

   The AI agent works best when your projects are git-initialized:
   ${GREEN}git init${RESET}     - Initialize a new repo
   
   This allows the agent to:
   ✓ Track your code changes with precise diffs
   ✓ Know exactly what you modified in each file
   ✓ Answer "what did I change?" with actual code
   ✓ Understand your project structure better

${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}

${BOLD}Quick Start:${RESET}
   ${GREEN}ai ask "what am I working on?"${RESET}  - Ask the AI anything
   ${GREEN}ai watch ~/code${RESET}                 - Monitor file changes
   ${GREEN}ai setup${RESET}                        - Configure API keys
   ${GREEN}ai status${RESET}                       - See current context

${BOLD}Enable Terminal Monitoring:${RESET}
   Add this to your ${YELLOW}~/.zshrc${RESET}:
   ${GREEN}source ${process.cwd()}/hooks/zsh-hook.sh${RESET}
   
   Then run: ${GREEN}ai-monitor on${RESET}

${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}
`);
