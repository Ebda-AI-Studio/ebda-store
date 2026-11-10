// Page components import their stylesheets (`import '@/app/services.css'`). Outside the bundler a stylesheet is not a
// module, so a script that renders pages imports this file FIRST: it makes every `.css` import an empty module.
import Module from 'node:module';

type Loader = (module: unknown, filename: string) => void;
(Module as unknown as { _extensions: Record<string, Loader> })._extensions['.css'] = () => {};
