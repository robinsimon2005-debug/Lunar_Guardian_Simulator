import * as THREE from "three";

export class CameraRig {
  constructor(camera) {
    this.camera = camera;
    this.mode = "eva"; // eva | rover | roverFpv | extract
    this.orbit = 0;
    this._pos = new THREE.Vector3();
    this._look = new THREE.Vector3();
  }

  setMode(mode) {
    this.mode = mode;
  }

  toggleRover() {
    if (this.mode === "rover") this.mode = "roverFpv";
    else if (this.mode === "roverFpv") this.mode = "eva";
    else this.mode = "rover";
  }

  update(dt, astronaut, rover) {
    if (this.mode === "extract") {
      if (!rover.arrived) {
        // Rover still driving to the drill site: follow it from behind.
        this._extractCam = null;
        const back = new THREE.Vector3(0, 0, -1).applyQuaternion(rover.group.quaternion);
        back.y = 0;
        back.normalize();
        const desired = rover.position.clone().addScaledVector(back, 11).add(new THREE.Vector3(0, 4.2, 0));
        this.camera.position.lerp(desired, 1 - Math.pow(0.02, dt));
        this.camera.lookAt(rover.position.clone().add(new THREE.Vector3(0, 1.6, 0)));
        return;
      }
      // Fixed camera: placed once the rover is parked, off to the side so the
      // arm, the drill and the core sample all stay in frame. It does not orbit.
      if (!this._extractCam) {
        const site = rover.workPointWorld();
        const mid = rover.position.clone().add(site).multiplyScalar(0.5);
        const fwd = site.clone().sub(rover.position);
        fwd.y = 0;
        fwd.normalize();
        const side = new THREE.Vector3(fwd.z, 0, -fwd.x);
        const pos = mid.clone().addScaledVector(side, 11.5);
        pos.y = Math.max(
          mid.y + 3.4,
          rover.terrain.heightAt(pos.x, pos.z) + 2.4
        );
        this._extractCam = { pos, look: mid.clone().add(new THREE.Vector3(0, 1.1, 0)) };
      }
      this.camera.position.lerp(this._extractCam.pos, 1 - Math.pow(0.02, dt));
      this.camera.lookAt(this._extractCam.look);
      return;
    }
    this._extractCam = null;

    if (this.mode === "roverFpv") {
      const p = new THREE.Vector3();
      rover.bumperCam.getWorldPosition(p);
      const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(rover.group.quaternion);
      this.camera.position.lerp(p, 0.35);
      this.camera.lookAt(p.clone().add(fwd.multiplyScalar(12)).add(new THREE.Vector3(0, 0.4, 0)));
      return;
    }

    if (this.mode === "rover") {
      const back = new THREE.Vector3(0, 0, -1).applyQuaternion(rover.group.quaternion);
      const desired = rover.position.clone().add(new THREE.Vector3(0, 4.2, 0)).addScaledVector(back, 11);
      this.camera.position.lerp(desired, 1 - Math.pow(0.02, dt));
      const look = rover.position.clone().add(new THREE.Vector3(0, 1.6, 0));
      this.camera.lookAt(look);
      return;
    }

    const yaw = astronaut.yaw;
    const pitch = astronaut.pitch;
    const dist = 13.5;
    const offset = new THREE.Vector3(
      Math.sin(yaw) * -dist,
      5.2 + pitch * 5,
      Math.cos(yaw) * -dist
    );
    const desired = astronaut.position.clone().add(offset);
    this.camera.position.lerp(desired, 1 - Math.pow(0.012, dt));
    const gh =
      astronaut.terrain.heightAt(this.camera.position.x, this.camera.position.z) + 1.6;
    if (this.camera.position.y < gh) this.camera.position.y = gh;
    const look = astronaut.position.clone().add(
      new THREE.Vector3(Math.sin(yaw) * 6, 1.4 - pitch * 8, Math.cos(yaw) * 6)
    );
    this.camera.lookAt(look);
  }
}
