import { mountChat } from "./chat.ts";
import "./style.css";
const root = document.querySelector<HTMLElement>("#app");
if (!root) {
  throw new Error("Missing app root");
}
mountChat(root);
