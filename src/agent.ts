import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { askWithTimeout, client, connectAgent } from "./agent-core.js";

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
                const answer = await askWithTimeout(prompt);

                console.log("\nGemini:", answer);
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


