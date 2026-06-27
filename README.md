# StreamProxy PTY

Intercepts terminal stdout, extracts embedded JSON payloads dynamically, and renders them in a virtualized side panel without blocking the main terminal interaction loop[cite: 7].

## 🚀 Key Features

- **Asynchronous Stream Parsing:** Avoids Extension Host bottlenecks by offloading heavy chunk scanning away from the main interaction threads.
- **Robust ANSI Escape Sequence Recovery:** State-machine architecture ensures complete preservation of split multi-chunk control codes (CSI, OSC, SS2/SS3).
- **Virtualized Lifecycle Management:** Recycles side panels efficiently and handles dynamic window recycling and configuration updates seamlessly.

## 📦 Installation

Install directly via the VS Code Marketplace or by searching for **StreamProxy PTY** in the extensions tab (`Ctrl+Shift+X`).

## 🛠️ Usage / How it Works

1. Open the command palette (`Ctrl+Shift+P`) and trigger `StreamProxy: Open JSON Panel`[cite: 7].
2. Launch a **StreamProxy Shell** terminal profile[cite: 7].
3. Any CLI output containing structural JSON objects will automatically clean themselves from the primary scrollback stream and route straight to your side-panel explorer UI.

## ⚙️ Configuration

Configure settings in your global `settings.json`:

* `streamproxy-pty.maxPanelEntries`: Pruning limits for cached side panel history (Default: `500`)[cite: 7].
* `streamproxy-pty.placeholderStyle`: Style adjustments for in-line stream indicators (`inline` | `minimal`) (Default: `inline`)[cite: 7].

## 📜 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.