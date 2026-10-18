// broken-plugin -- the fail-isolation fixture.
//
// Activation throws on purpose. The loader must catch this, record a
// diagnostic, and leave every other plugin and the session itself untouched.
// If a single line of this file can take down `aflow chat`, the plugin system
// is not finished.

throw new Error("broken-plugin refuses to activate (fixture)");
