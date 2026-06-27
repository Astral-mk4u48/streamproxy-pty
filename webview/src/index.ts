declare function acquireVsCodeApi(): any;

// Webview frontend entrypoint initialization
const vscode = acquireVsCodeApi();

window.addEventListener('message', (event) => {
    const message = event.data;
    console.log('Webview received data payload:', message);
});