import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { askWithTimeout, client, connectAgent, type AgentStep, type ChatHistory } from "./agent-core.js";

async function main() {
    const tools = await connectAgent();

    console.log("InventoryWatch Agent is ready.");
    console.log("Available tools:");

    for (const tool of tools.tools) {
        console.log(`- ${tool.name}`);
    }

    const rl = readline.createInterface({
        input: stdin,
        output: stdout,
    });

    // One conversation for the whole CLI session, so the agent can ask follow-up questions.
    const history: ChatHistory = [];

    try {
        while (true) {
            const prompt = await rl.question("\nYou: ");

            if (prompt.trim().toLowerCase() === "exit") {
                break;
            }

            if (!prompt.trim()) {
                continue;
            }

            try {
                const steps: AgentStep[] = [];
                const answer = await askWithTimeout(prompt, steps, history);

                console.log("\nGemini:", answer);

                // The CLI has no buttons, so a change that waits for confirmation is asked here as y/n.
                const waiting = steps.filter((step) => step.pending).pop();

                if (waiting) {
                    const reply = await rl.question(`\nJalankan ${waiting.name} ${JSON.stringify(waiting.args)}? (y/n): `);

                    if (reply.trim().toLowerCase() === "y") {
                        console.log("\nGemini:", await askWithTimeout("Ya, lanjutkan.", [], history, { confirm: true }));
                    } else {
                        console.log("Dibatalkan.");
                    }
                }
            } catch (error) {
                console.error(
                    "\nRequest failed:",
                    error instanceof Error ? error.message : error,
                );
            }
        }
    } finally {
        rl.close();
        await client.close();
    }
}

main().catch((error) => {
    console.error("Agent error:", error);
    process.exitCode = 1;
});


