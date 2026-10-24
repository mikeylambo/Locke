import "./ui/styles.css";
import { Game } from "./game/game";

const game = new Game(document.getElementById("game") as HTMLCanvasElement, document.getElementById("ui")!);
void game.boot();
