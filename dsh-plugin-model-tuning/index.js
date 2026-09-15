/**
 * Host loader entry for the browser implementation exported from `./client`.
 * No host-side behavior: the settings surface reads and writes entirely
 * through the unified `connection.api` (llm.providers / llm.models /
 * settings.describe / settings.mutate) from the browser.
 */
function apply() {}
export { apply };
