import objMgr, { me } from './Core/ObjectManager';
import dbgWindow from './Debug/DebugWindow';
import perfMgr from './Debug/PerfMgr';
import nuclear from './nuclear';
import extensions from './Extensions/Extensions';
import data from './Data/Data';
import targeting from './Targeting/Targeting';

let pauseCore = false
nuclear.initialize().then(() => {
  // our "main loop", called every tick
  setInterval(_ => {
    if (imgui.isKeyPressed(imgui.Key.Pause, false)) {
      pauseCore = !pauseCore
    }

    if (pauseCore) {
      return;
    }

    perfMgr.begin("total");
    objMgr.tick();
    nuclear.tick();
    dbgWindow.tick();
    perfMgr.end("total");
    perfMgr.render();
  }, 1);

  console.info("Nuclear initialized");
}).catch(reason => {
  console.error(`${reason}`);
  console.error(`${reason.stack}`);
});
