// The TypeDoc plugin .config/typedoc.json loads: drops the pills that tell a reader nothing.
import { PageEvent, type Application } from 'typedoc';

export function load(app: Application) {
  // Optional: the signature's `?` says it already. The flag stays, since the `?` comes from it.
  // shortcut: matches the default theme's markup; check the pills after a TypeDoc upgrade.
  app.renderer.on(PageEvent.END, (page) => {
    page.contents = page.contents?.replace(/<code class="tsd-tag">Optional<\/code> ?/g, '');
  });
}
