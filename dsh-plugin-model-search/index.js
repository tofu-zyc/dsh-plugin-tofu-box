/**
 * Host loader entry for the browser-only model-search plugin.
 * All behavior lives in `./client`: it shadows the built-in
 * `conversation.input.model` slot with a searchable model menu and routes
 * every selection through the existing `modelDirectories` service.
 */
function apply() {}
export { apply };
