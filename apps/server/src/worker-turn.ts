import { EngineError, type Engine } from '@media-router/engine';

/** The production entry point omits billing. Local fixtures may inject an isolated turn. */
export async function workServerOnce(
  engine: Pick<Engine, 'workOnce' | 'events' | 'notificationEmail'>,
  billing?: { workOnce(): Promise<void> },
): Promise<void> {
  try {
    await engine.workOnce();
  } catch (error) {
    // A qualification transition pauses new provider work, not accepted event,
    // notification or payment maintenance. Unexpected failures still propagate.
    if (!(error instanceof EngineError) || error.code !== 'execution_scope_transition_required')
      throw error;
  }
  await engine.events.workOnce();
  await engine.events.scanAlerts();
  await engine.notificationEmail.workOnce();
  await billing?.workOnce();
}
