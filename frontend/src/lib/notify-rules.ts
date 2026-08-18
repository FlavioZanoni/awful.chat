/**
 * When does an incoming message make a sound?
 *
 * Pure so it can be tested: the focus axis cannot be driven in a headless
 * browser, which always reports itself focused.
 */
export function shouldPlayMessageSound(input: {
  /** The user has message sounds switched on. */
  enabled: boolean;
  /** The conversation this message belongs to is the one on screen. */
  viewingConversation: boolean;
  /** The window has focus. */
  focused: boolean;
}): boolean {
  if (!input.enabled) return false;
  // Reading the conversation as the message lands: the sound would only
  // announce what the eyes already saw. Every other combination plays -
  // including viewing-but-unfocused, where "on screen" means nothing.
  return !(input.viewingConversation && input.focused);
}
