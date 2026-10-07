import { processLearningWake } from './service.js';
export async function handleAutonomousQueue(batch, env) { for (const message of batch.messages || []) {
    try {
        await processLearningWake(message, env);
    }
    catch {
        message.retry({ delaySeconds: 30 });
    }
} }
