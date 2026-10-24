export class Input {
  constructor() {
    this.keys = new Set();
    this.look = { x: 0, y: 0 };
    this.pointerLocked = false;
    this._just = new Set();

    window.addEventListener("keydown", (e) => {
      if (["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.code)) {
        e.preventDefault();
      }
      if (!this.keys.has(e.code)) this._just.add(e.code);
      this.keys.add(e.code);
    });
    window.addEventListener("keyup", (e) => this.keys.delete(e.code));
    window.addEventListener("blur", () => this.keys.clear());

    document.addEventListener("mousemove", (e) => {
      if (!this.pointerLocked) return;
      this.look.x -= e.movementX * 0.0024;
      this.look.y += e.movementY * 0.002;
      this.look.y = Math.max(-1.15, Math.min(0.65, this.look.y));
    });

    document.addEventListener("pointerlockchange", () => {
      this.pointerLocked = document.pointerLockElement != null;
    });
  }

  down(code) {
    return this.keys.has(code);
  }

  pressed(code) {
    return this._just.has(code);
  }

  endFrame() {
    this._just.clear();
  }

  axis() {
    let x = 0;
    let z = 0;
    if (this.down("KeyD")) x += 1;
    if (this.down("KeyA")) x -= 1;
    if (this.down("KeyW")) z -= 1;
    if (this.down("KeyS")) z += 1;
    const len = Math.hypot(x, z) || 1;
    return { x: x / len, z: z / len };
  }
}
