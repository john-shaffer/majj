// jj's editor (ui.editor) while majj edits a description. It hands the file
// to the extension over MAJJ_EDITOR_SOCKET and exits once editing is done:
// 0 to let jj use the saved file, or 1 to make jj abort.

import * as net from "net";

const file = process.argv[process.argv.length - 1];
let reply = "";
const socket = net.connect(process.env.MAJJ_EDITOR_SOCKET!, () => socket.write(`${file}\n`));
socket.setEncoding("utf8");
socket.on("data", (data) => (reply += data));
socket.on("close", () => process.exit(reply.trim() === "finish" ? 0 : 1));
socket.on("error", () => process.exit(1));
