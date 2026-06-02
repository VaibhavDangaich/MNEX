#!/usr/bin/env node

/**
 * Post-install script
 * Prompts for API keys during installation - REQUIRED for agent to work
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const readline = require("readline");

const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

const HOME = os.homedir();
const CONFIG_DIR = path.join(HOME, ".config", "ai-agent");
const CONFIG_FILE = path.join(CONFIG_DIR, ".env");

/**
 * Check if already configured
 */
function isConfigured() {
    if (!fs.existsSync(CONFIG_FILE)) return false;
    
    const content = fs.readFileSync(CONFIG_FILE, "utf-8");
    return content.includes("OPENAI_API_KEY=") || content.includes("GEMINI_API_KEY=");
}

/**
 * Create readline interface
 */
function createRL() {
    return readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });
}

/**
 * Prompt for input
 */
function prompt(rl, question) {
    return new Promise(resolve => {
        rl.question(question, answer => {
            resolve(answer.trim());
        });
    });
}

/**
 * Main setup flow
 */
async function main() {
    console.log(`
${CYAN}╔════════════════════════════════════════════════════════════════╗${RESET}
${CYAN}║${RESET}  ${BOLD}🤖 AI CLI Agent - Setup Required${RESET}                              ${CYAN}║${RESET}
${CYAN}╚════════════════════════════════════════════════════════════════╝${RESET}
`);

    // Check if already configured
    if (isConfigured()) {
        console.log(`${GREEN}✅ API keys already configured!${RESET}`);
        console.log(`   Config: ${CONFIG_FILE}\n`);
        console.log(`${BOLD}Get started:${RESET}`);
        console.log(`   ${GREEN}ai ask "hello, what can you do?"${RESET}`);
        console.log(`   ${GREEN}ai service start${RESET}  ${DIM}# Enable background monitoring${RESET}\n`);
        return;
    }

    // Check if running in CI/non-interactive
    if (!process.stdin.isTTY) {
        console.log(`${YELLOW}⚠️  Non-interactive environment detected.${RESET}`);
        console.log(`   Run ${GREEN}ai init${RESET} after installation to configure API keys.\n`);
        return;
    }

    console.log(`${BOLD}This agent requires API keys to function:${RESET}\n`);
    console.log(`   • ${BOLD}OpenAI${RESET} or ${BOLD}Gemini${RESET} API Key ${DIM}(for AI capabilities)${RESET}`);
    console.log(`   • ${BOLD}Supermemory${RESET} API Key ${DIM}(for cloud sync - optional)${RESET}\n`);

    const rl = createRL();

    try {
        const setupNow = await prompt(rl, `${BOLD}Would you like to set up API keys now? (y/n):${RESET} `);
        
        if (setupNow.toLowerCase() !== 'y' && setupNow.toLowerCase() !== 'yes') {
            console.log(`\n${YELLOW}⚠️  Setup skipped.${RESET}`);
            console.log(`   The agent will NOT work without API keys.`);
            console.log(`   Run ${GREEN}ai init${RESET} to configure when ready.\n`);
            rl.close();
            return;
        }

        console.log(`\n${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}\n`);

        // Choose LLM Provider
        console.log(`${BOLD}Choose your LLM provider:${RESET}`);
        console.log(`   1. OpenAI ${DIM}(GPT-4, etc.)${RESET}`);
        console.log(`   2. Google Gemini ${DIM}(Free tier available)${RESET}\n`);
        
        const providerChoice = await prompt(rl, `${BOLD}Enter 1 or 2:${RESET} `);
        const provider = providerChoice === '2' ? 'gemini' : 'openai';

        console.log();

        // Get API Key
        let apiKey = '';
        if (provider === 'openai') {
            console.log(`${DIM}Get your key: https://platform.openai.com/api-keys${RESET}`);
            apiKey = await prompt(rl, `${BOLD}Enter OpenAI API Key:${RESET} `);
        } else {
            console.log(`${DIM}Get your key: https://aistudio.google.com/apikey${RESET}`);
            apiKey = await prompt(rl, `${BOLD}Enter Gemini API Key:${RESET} `);
        }

        if (!apiKey) {
            console.log(`\n${RED}❌ No API key provided. Setup cancelled.${RESET}`);
            console.log(`   Run ${GREEN}ai init${RESET} to try again.\n`);
            rl.close();
            return;
        }

        console.log(`\n${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}\n`);

        // Supermemory (optional)
        console.log(`${BOLD}Supermemory API Key ${DIM}(optional - for cloud sync & multi-device)${RESET}`);
        console.log(`${DIM}Get your key: https://supermemory.ai${RESET}\n`);
        
        const supermemoryKey = await prompt(rl, `${BOLD}Enter Supermemory API Key (or press Enter to skip):${RESET} `);

        console.log(`\n${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}\n`);

        // Build config content
        let envContent = `# AI Agent Configuration\n`;
        envContent += `# Generated during installation\n\n`;
        envContent += `LLM_PROVIDER=${provider}\n`;
        
        if (provider === 'openai') {
            envContent += `OPENAI_API_KEY=${apiKey}\n`;
        } else {
            envContent += `GEMINI_API_KEY=${apiKey}\n`;
        }

        if (supermemoryKey) {
            envContent += `SUPERMEMORY_API_KEY=${supermemoryKey}\n`;
        }

        // Create config directory
        if (!fs.existsSync(CONFIG_DIR)) {
            fs.mkdirSync(CONFIG_DIR, { recursive: true });
        }

        // Write config
        fs.writeFileSync(CONFIG_FILE, envContent);

        console.log(`${GREEN}✅ Configuration saved!${RESET}`);
        console.log(`   ${DIM}${CONFIG_FILE}${RESET}\n`);

        // Show next steps
        console.log(`${BOLD}🎉 Setup Complete! Get started:${RESET}\n`);
        console.log(`   ${GREEN}ai ask "hello, what can you do?"${RESET}  ${DIM}# Try it now${RESET}`);
        console.log(`   ${GREEN}ai service start${RESET}                  ${DIM}# Enable monitoring${RESET}`);
        console.log(`   ${GREEN}ai status${RESET}                         ${DIM}# See current context${RESET}\n`);

        if (supermemoryKey) {
            console.log(`${CYAN}☁️  Cloud sync enabled!${RESET} Your context syncs across devices.\n`);
        }

        rl.close();

    } catch (error) {
        console.error(`\n${RED}Error during setup:${RESET}`, error.message);
        console.log(`Run ${GREEN}ai init${RESET} to try again.\n`);
        rl.close();
    }
}

main().catch(console.error);
