// Pulls the CSS out of src/styles.css → dist/webview.css so the HTML
// <link> tag can load it separately from the JS bundle.
import { copyFileSync, mkdirSync } from 'fs';
mkdirSync('dist', { recursive: true });
copyFileSync('src/styles.css', 'dist/webview.css');
