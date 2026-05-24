
(function(){
  const canvas = document.getElementById('strobeCanvas');
  const ctx = canvas.getContext('2d');
  const W = 660, H = 450;

  // Offscreen buffer that accumulates the disc's light (Afterimage ON model).
  const acc = document.createElement('canvas');
  acc.width = W; acc.height = H;
  const accCtx = acc.getContext('2d');

  const root = document.getElementById('strobeRoot');
  const canvasWrap = document.getElementById('canvasWrap');

  const css = getComputedStyle(document.documentElement);
  function v(name, fb){ const x = css.getPropertyValue(name).trim(); return x || fb; }
  const colText = v('--color-text-primary', '#1a1a1a');
  const colSub  = v('--color-text-secondary', '#666');
  const isDark  = (function(){ const c=v('--color-background-primary','#fff'); return /^#?(0|1|2|3)/.test(c.replace('#','')); })();

  const discR = 150;
  const cx = 200, cy = 235;
  const ledX = 470, ledY = 100;

  const FPS_REF = 60;
  const FRAME_S = 1 / FPS_REF;
  const FLASH_PERIOD_FRAMES = 16;         // 1/8 duty with flashOnFrames=2 (matches real hardware)
  const DEG_PER_FRAME = 360.0 / 24 / 16;  // 15deg/flash = 1 slots at 24 marks -> stays still

  const FLASH_PERIOD_S = FLASH_PERIOD_FRAMES / FPS_REF;
  const DEG_PER_S = DEG_PER_FRAME * FPS_REF;
  const RAD_PER_S = DEG_PER_S * Math.PI / 180;
  const RAD_PER_FRAME = DEG_PER_FRAME * Math.PI / 180;

  // --- Per-page configuration (the program is shared; only this differs per HTML) ---
  // Set window.STROBE_CONFIG in the HTML *before* loading this script to override.
  // The two simulations differ only by which composite op each region uses while lit:
  //   Printed pattern : pattern = 'source-over' (dark marks), gap = 'lighter' (bright surface)
  //   LED stroboscope : pattern = 'lighter' (emitting LEDs), gap = 'source-over' (dark board)
  const CFG = Object.assign({
    patternOp: 'source-over',   // composite for the pattern region while lit
    patternColor: '#1a1a1a',    // pattern fill color
    patternColorAlt: '#5a5a5a', // pattern fill for scenes with lightBand:true
    patternAlphaPerS: 30,       // pattern deposit speed (alpha/sec)
    gapOp: 'lighter',           // composite for the non-pattern region while lit
    gapColor: '#111111',        // non-pattern fill color
    gapAlphaPerS: 45,           // non-pattern deposit speed (alpha/sec)
    markInner: 0.62,            // pattern inner radius (fraction of discR) — radial length start
    markOuter: 0.92,            // pattern outer radius (fraction of discR) — radial length end
    markDuty: 0.3333,           // pattern angular width as a fraction of one slot
    // Afterimage OFF (instantaneous) colors:
    discLit: '#ffffff',         // disc surface while the light is ON
    discDark: '#3a3a3a',        // disc surface while the light is OFF
    markLit: '#1a1a1a',         // pattern (mark/LED) while the light is ON  (the lit band)
    markOff: '#2a2a2a',         // pattern (mark/LED) while the light is OFF
    markGhost: '#f3f3f2',       // all marks shown faintly while lit (set = markLit to make every LED light up)
    // Disc base colors (afterimage ON accumulation buffer):
    initColor: '#888888',       // disc fill before any flash
    decayColor: '#000000',      // afterimage fades toward this between flashes
    decayAlphaPerS: 0.2,        // afterimage fade speed (alpha/sec); lower = longer-lasting
    scenes: null                // optional per-page scene list (null => built-in default)
  }, (typeof window !== 'undefined' && window.STROBE_CONFIG) || {});

  const R2 = discR*CFG.markOuter;
  const R1 = discR*CFG.markInner;
  // Marks are radial sectors (wedges) whose sides are lines through the disc center.
  // MARK_DUTY = fraction of each angular slot (2*PI / marks) covered by the pattern.
  const MARK_DUTY = CFG.markDuty;
  function markHalfAngle(){ return Math.PI * MARK_DUTY / nMarks(); }
  const GHOST_COLOR = CFG.markGhost;

  // --- Afterimage OFF (instantaneous color-overlay model) ---
  const BAND_ALPHA = 0.9;
  const BAND_COLOR_REST = CFG.markLit;
  const DISC_LIT = CFG.discLit;
  const DISC_DARK = CFG.discDark;
  const GHOST_DARK = CFG.markOff;

  // --- Afterimage ON (light-accumulation model) ---
  // The disc starts dark. While lit, the gaps (disc minus marks) accumulate light with
  // composite 'lighter' (toward white), while the marks are painted with 'source-over'
  // toward a dark gray. Using 'source-over' for the marks lets a previously brightened
  // region (e.g. left bright after Scene 3/4 drift) be pulled back DOWN to dark when the
  // marks land there repeatedly — which additive 'lighter' (black adds nothing) cannot do.
  // Between flashes the whole disc fades toward DECAY_COLOR (source-over).
  // All rates are per-second and scaled by dt for a frame-rate-independent result.
  const INIT_DISC_COLOR = CFG.initColor;  // disc fill before any flash
  const DECAY_COLOR = CFG.decayColor;     // afterimage fades toward this between flashes
  const DECAY_ALPHA_PER_S = CFG.decayAlphaPerS; // fade speed; lower = longer-lasting afterimage
  const ADD_ALPHA_PER_S = CFG.gapAlphaPerS;      // non-pattern deposit speed while lit
  const MARK_ALPHA_PER_S = CFG.patternAlphaPerS; // pattern deposit speed while lit
  const GAP_OP = CFG.gapOp;                       // composite op for the non-pattern region
  const PATTERN_OP = CFG.patternOp;               // composite op for the pattern region
  const LIGHT_BG = CFG.gapColor;                  // non-pattern fill color
  const LIGHT_MARK = CFG.patternColor;            // pattern fill color
  const LIGHT_MARK_LIGHT = CFG.patternColorAlt;   // pattern fill for lightBand scenes

  const ARROW_RED = '#d6433b';
  const ARROW_BLUE = '#2f6fd0';
  const ARROW_GREEN = '#2e9e5b';

  const SCENES = CFG.scenes || [
    {
      flashOnFrames: 16, speedFactor: 1.0, marks: 24, lightBand: false,
      label: 'Scene 1 — Continuous light',
      status: 'Rotating', statusColor: 'info', motion: 'Blurred motion', motionColor: 'info',
      desc: 'The light stays on continuously. The marks blur into motion and the rotation is clearly visible.',
      arrow: null
    },
    {
      flashOnFrames: 2, speedFactor: 1.0, marks: 24, lightBand: false,
      label: 'Scene 2 — Strobe flashing (speed matches)',
      status: 'Stays still', statusColor: 'success', motion: 'Stays still', motionColor: 'success',
      desc: 'The light flashes at a fixed frequency. Each flash advances the disc by a whole number of slots, so every mark is lit in the same place and the pattern stays still.',
      arrow: 'still'
    },
    {
      flashOnFrames: 2, speedFactor: 0.975, marks: 24, lightBand: false,
      label: 'Scene 3 — Rotation slightly slow',
      status: 'Slow backward drift', statusColor: 'danger', motion: 'Drifts backward', motionColor: 'danger',
      desc: 'The rotation is slightly slower than the matching speed, so each flash catches the marks a little behind and the pattern drifts slowly backward.',
      arrow: 'ccw'
    },
    {
      flashOnFrames: 2, speedFactor: 1.025, marks: 24, lightBand: false,
      label: 'Scene 4 — Rotation slightly fast',
      status: 'Slow forward drift', statusColor: 'warning', motion: 'Drifts forward', motionColor: 'warning',
      desc: 'The rotation is slightly faster than the matching speed, so each flash catches the marks a little ahead and the pattern drifts slowly forward.',
      arrow: 'cw'
    },
    {
      flashOnFrames: 2, speedFactor: 1.0, marks: 24, markStep: 4, lightBand: true,
      label: 'Scene 5 — Printed pattern (stride 4)',
      status: 'Stays still', statusColor: 'success', motion: 'Stays still', motionColor: 'success',
      desc: 'A printed disc with a sparse pattern (stride 4), lit by the same strobe. This shows what happens when a printed pattern is used instead of LED scanning.',
      arrow: null
    }
  ];

  let sceneIdx = 1;
  let playing = false;
  let trailOn = true;
  let discAngle = 0;
  let strobePhase = 0;
  let lastTs = 0;
  let currentBand = null;
  let frameCount = 0;

  const playBtn = document.getElementById('playBtn');
  const playLabel = document.getElementById('playLabel');
  const stepBtn = document.getElementById('stepBtn');
  const resetBtn = document.getElementById('resetBtn');
  const trailBtn = document.getElementById('trailBtn');
  const trailLabel = document.getElementById('trailLabel');
  const frameInfo = document.getElementById('frameInfo');
  const sceneBtns = [
    document.getElementById('scene1Btn'),
    document.getElementById('scene2Btn'),
    document.getElementById('scene3Btn'),
    document.getElementById('scene4Btn'),
    document.getElementById('scene5Btn')
  ];
  const sceneLabelEl = document.getElementById('sceneLabel');
  const sceneStatusEl = document.getElementById('sceneStatus');
  const sceneDescEl = document.getElementById('sceneDesc');

  let standalone = false;
  try { standalone = (window.self === window.top); } catch(e){ standalone = false; }

  if(standalone){
    document.documentElement.style.height = '100%';
    document.body.style.height = '100%';
    document.body.style.margin = '0';
    let p = root.parentElement;
    while(p && p !== document.body){ p.style.height = '100%'; p = p.parentElement; }
    root.style.height = '100%';
    root.style.maxHeight = '100%';
    root.style.overflow = 'hidden';
    canvasWrap.style.flex = '1 1 auto';
  } else {
    root.style.height = 'auto';
    canvasWrap.style.flex = '0 0 auto';
  }

  // Scale the canvas to fill canvasWrap while keeping the 660:450 aspect ratio.
  // canvasWrap's size is settled by flex layout, so measuring it does not create
  // a circular dependency with the canvas size.
  function fitCanvas(){
    let availW, availH;
    if(standalone){
      const r = canvasWrap.getBoundingClientRect();
      availW = r.width;
      availH = r.height;
    } else {
      availW = root.clientWidth || W;
      availH = H;
    }
    if(availW < 10 || availH < 10){
      canvas.style.width = W + 'px';
      canvas.style.height = H + 'px';
      return;
    }
    let scale = Math.min(availW / W, availH / H);
    if(!standalone) scale = Math.min(scale, 1);
    if(scale < 0.2) scale = 0.2;
    canvas.style.width = (W * scale) + 'px';
    canvas.style.height = (H * scale) + 'px';
  }

  function statusBg(kind){
    return { info:v('--color-background-info','#e6f1fb'), success:v('--color-background-success','#e1f5ee'),
             warning:v('--color-background-warning','#faeeda'), danger:v('--color-background-danger','#fcebeb') }[kind];
  }
  function statusFg(kind){
    return { info:v('--color-text-info','#185fa5'), success:v('--color-text-success','#0f6e56'),
             warning:v('--color-text-warning','#854f0b'), danger:v('--color-text-danger','#a32d2d') }[kind];
  }

  function curScene(){ return SCENES[sceneIdx]; }
  // nMarks = grid resolution (sync + mark width are based on this; same for all scenes).
  function nMarks(){ return curScene().marks; }
  // markStep = draw a mark every this many grid slots. 1 = every slot (LED disc);
  // Scene 5 uses 4 to show a sparse printed pattern with the SAME individual mark shape.
  function markStep(){ return curScene().markStep || 1; }
  // Number of marks actually drawn (used for the caption).
  function nDrawnMarks(){ return Math.ceil(nMarks() / markStep()); }

  function flashOnS(){ return curScene().flashOnFrames / FPS_REF; }
  function isLit(){ return strobePhase < flashOnS(); }
  function oneMark(){
    // Drawn in a frame already rotated so the mark points up (center angle -90deg).
    const ac = -Math.PI/2;
    const h = markHalfAngle();
    const a1 = ac - h, a2 = ac + h;
    ctx.beginPath();
    ctx.moveTo(R2*Math.cos(a1), R2*Math.sin(a1));
    ctx.arc(0, 0, R2, a1, a2, false);
    ctx.arc(0, 0, R1, a2, a1, true);
    ctx.closePath();
    ctx.fill();
  }

  function drawMarksAt(angle, color, alpha){
    const N = nMarks(), step = markStep();
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.rotate(angle);
    ctx.fillStyle = color;
    for(let k=0;k<N;k+=step){
      ctx.save();
      ctx.rotate((k/N)*Math.PI*2);
      oneMark();
      ctx.restore();
    }
    ctx.restore();
  }

  function drawArc(angStart, angEnd, color, alpha){
    const N = nMarks(), step = markStep();
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = color;
    const span = Math.max(0, angEnd - angStart);
    const SUB = Math.max(1, Math.ceil(span / (0.5*Math.PI/180)));
    for(let s=0;s<=SUB;s++){
      const ang = angStart + span*(s/SUB);
      ctx.save();
      ctx.rotate(ang);
      for(let k=0;k<N;k+=step){
        ctx.save();
        ctx.rotate((k/N)*Math.PI*2);
        oneMark();
        ctx.restore();
      }
      ctx.restore();
    }
    ctx.restore();
  }

  // --- Light-accumulation buffer helpers (Afterimage ON) ---

  // Append one wedge-shaped mark (centered at angle th) as a closed subpath on context c.
  // Sides are radial lines through the disc center; width grows with radius.
  function addRotatedMark(c, th){
    const ac = th - Math.PI/2;
    const h = markHalfAngle();
    const a1 = ac - h, a2 = ac + h;
    c.moveTo(R2*Math.cos(a1), R2*Math.sin(a1));
    c.arc(0, 0, R2, a1, a2, false);
    c.arc(0, 0, R1, a2, a1, true);
    c.closePath();
  }

  // Path = whole disc with the marks punched out (fill with 'evenodd' → gaps only).
  function discMinusMarksPath(c, baseAng){
    const N = nMarks(), step = markStep();
    c.beginPath();
    c.arc(0,0,discR,0,Math.PI*2);
    for(let k=0;k<N;k+=step){ addRotatedMark(c, baseAng + (k/N)*Math.PI*2); }
  }

  // Path = the marks only.
  function marksPath(c, baseAng){
    const N = nMarks(), step = markStep();
    c.beginPath();
    for(let k=0;k<N;k+=step){ addRotatedMark(c, baseAng + (k/N)*Math.PI*2); }
  }

  // (Re)initialize the buffer to a uniform mid-gray disc (no accumulated light yet).
  function accClear(){
    accCtx.setTransform(1,0,0,1,0,0);
    accCtx.clearRect(0,0,W,H);
    accCtx.save();
    accCtx.translate(cx, cy);
    accCtx.globalCompositeOperation = 'source-over';
    accCtx.globalAlpha = 1;
    accCtx.fillStyle = INIT_DISC_COLOR;
    accCtx.beginPath();
    accCtx.arc(0,0,discR,0,Math.PI*2);
    accCtx.fill();
    accCtx.restore();
  }

  // Light-off frame: pull the disc toward DECAY_COLOR (source-over) so the afterimage fades.
  function accDecay(dt){
    const a = Math.min(1, DECAY_ALPHA_PER_S * dt);
    accCtx.save();
    accCtx.translate(cx, cy);
    accCtx.globalCompositeOperation = 'source-over';
    accCtx.globalAlpha = a;
    accCtx.fillStyle = DECAY_COLOR;
    accCtx.beginPath();
    accCtx.arc(0,0,discR,0,Math.PI*2);
    accCtx.fill();
    accCtx.restore();
  }

  // Light-on frame. Each region uses its configured composite op (see CFG):
  //   printed pattern -> gap 'lighter' (toward white), pattern 'source-over' (toward dark)
  //   LED stroboscope -> gap 'source-over' (toward dark), pattern 'lighter' (emitting)
  function accAdd(angPrev, angCur, dt){
    const sc = curScene();
    const aBg = Math.min(1, ADD_ALPHA_PER_S * dt);
    const aMark = Math.min(1, MARK_ALPHA_PER_S * dt);
    accCtx.save();
    accCtx.translate(cx, cy);

    // Non-pattern region = disc minus the pattern at the current angle.
    accCtx.globalCompositeOperation = GAP_OP;
    accCtx.globalAlpha = aBg;
    accCtx.fillStyle = LIGHT_BG;
    discMinusMarksPath(accCtx, angCur);
    accCtx.fill('evenodd');

    // Pattern region, swept across the rotation covered this frame to blur motion.
    accCtx.globalCompositeOperation = PATTERN_OP;
    accCtx.fillStyle = sc.lightBand ? LIGHT_MARK_LIGHT : LIGHT_MARK;
    const span = Math.abs(angCur - angPrev);
    const SUB = Math.max(1, Math.ceil(span / (0.5*Math.PI/180)));
    for(let s=0;s<=SUB;s++){
      accCtx.globalAlpha = aMark/(SUB+1);
      marksPath(accCtx, angPrev + (angCur-angPrev)*(s/SUB));
      accCtx.fill();
    }
    accCtx.restore();
  }

  function arcArrow(originX, originY, radius, midA, halfSpan, ccw, color, lineW, headL, headW){
    const aStart = midA - halfSpan;
    const aEnd = midA + halfSpan;
    ctx.save();
    ctx.translate(originX, originY);
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = lineW;
    ctx.lineCap = 'round';

    ctx.beginPath();
    ctx.arc(0, 0, radius, aStart, aEnd, false);
    ctx.stroke();

    const headA = ccw ? aStart : aEnd;
    const hx = radius * Math.cos(headA);
    const hy = radius * Math.sin(headA);
    const tang = ccw ? (headA - Math.PI/2) : (headA + Math.PI/2);
    const tipx = hx + headL*Math.cos(tang);
    const tipy = hy + headL*Math.sin(tang);
    const perpA = tang + Math.PI/2;
    const b1x = hx + headW*Math.cos(perpA);
    const b1y = hy + headW*Math.sin(perpA);
    const b2x = hx - headW*Math.cos(perpA);
    const b2y = hy - headW*Math.sin(perpA);
    ctx.beginPath();
    ctx.moveTo(tipx, tipy);
    ctx.lineTo(b1x, b1y);
    ctx.lineTo(b2x, b2y);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  function drawDriftArrow(dir, color){
    const aR = discR + 26;
    const midA = -Math.PI/4;
    const halfSpan = Math.PI/5;
    const ccw = (dir === 'ccw');
    arcArrow(cx, cy, aR, midA, halfSpan, ccw, color, 4.5, 13, 8);

    ctx.save();
    ctx.fillStyle = color;
    ctx.font = '600 14px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const lx = cx + (discR + 4);
    const ly = cy - (discR + 24);
    ctx.fillText('Pattern Drift (' + (ccw ? 'CCW' : 'CW') + ')', lx, ly);
    ctx.restore();
  }

  // Green "stays still" label at the same position as the drift label (no arc, no motion).
  function drawStillLabel(){
    ctx.save();
    ctx.fillStyle = ARROW_GREEN;
    ctx.font = '600 14px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Pattern stays still', cx + (discR + 4), cy - (discR + 24));
    ctx.restore();
  }

  // The outer rim is drawn as alternating dark/light segments (15 deg each) and rotated at
  // the TRUE rotation angle (continuous, not strobed). As it slides past the seemingly
  // still marks, the disc clearly reads as spinning.
  const RIM_R = 80;
  const RIM_W = 2;                 // rim band thickness
  const RIM_SEG = 96;              // segment degree = 360 / RIM_SEG
  const RIM_DARK = '#111111';
  const RIM_LIGHT = '#00a1e9';
  // Inner rim near the center: independent width / segment count from the outer rim.
  const INNER_RIM_R = 18;          // radius, clear of the hub and the marks (R1..R2)
  const INNER_RIM_W = 2;           // inner rim band thickness
  const INNER_RIM_SEG = 24;        // inner segment degree = 360 / INNER_RIM_SEG
  function drawRim(radius, width, seg){
    const segAng = 2*Math.PI/seg;
    ctx.save();
    ctx.lineWidth = width;
    for(let i=0;i<seg;i++){
      const a0 = -Math.PI/2 + discAngle + i*segAng;
      ctx.beginPath();
      ctx.arc(cx, cy, radius, a0, a0 + segAng + 0.004); // tiny overlap to avoid seams
      ctx.strokeStyle = (i % 2 === 0) ? RIM_DARK : RIM_LIGHT;
      ctx.stroke();
    }
    ctx.restore();
  }
  // Static (non-rotating) faint outer boundary at the disc edge — the original disc rim line.
  const EDGE_R = discR;
  const EDGE_COLOR = isDark ? '#55534c' : '#b4b2a9';
  function drawDiscEdge(){
    ctx.save();
    ctx.strokeStyle = EDGE_COLOR;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, EDGE_R, 0, Math.PI*2);
    ctx.stroke();
    ctx.restore();
  }
  function drawSpinRim(){
    drawDiscEdge();                                   // static outer boundary
    drawRim(RIM_R, RIM_W, RIM_SEG);                   // rotating rim
    drawRim(INNER_RIM_R, INNER_RIM_W, INNER_RIM_SEG); // rotating inner rim
  }

  function draw(){
    ctx.clearRect(0,0,W,H);
    const lit = isLit();
    const sc = curScene();
    const continuous = sc.flashOnFrames >= FLASH_PERIOD_FRAMES;

    if(trailOn){
      // Afterimage ON: the disc surface is the light-accumulation buffer.
      ctx.drawImage(acc, 0, 0);
      ctx.save();
      ctx.translate(cx, cy);
    } else {
      // Afterimage OFF: unchanged color-overlay rendering.
      const darkDisc = !lit;
      ctx.save();
      ctx.translate(cx, cy);

      ctx.beginPath();
      ctx.arc(0,0,discR,0,Math.PI*2);
      ctx.fillStyle = darkDisc ? DISC_DARK : DISC_LIT;
      ctx.fill();

      drawMarksAt(discAngle, darkDisc ? GHOST_DARK : GHOST_COLOR, 1);

      if(lit && currentBand){
        drawArc(currentBand.start, currentBand.end, BAND_COLOR_REST, BAND_ALPHA);
      }
    }

    // Center hub — drawn fresh each frame on top of the disc in both modes.
    ctx.beginPath();
    ctx.arc(0,0,11,0,Math.PI*2);
    ctx.fillStyle = isDark ? '#888' : '#a8a8a2';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(0,0,7,0,Math.PI*2);
    ctx.fillStyle = isDark ? '#aaa' : '#888';
    ctx.fill();
    ctx.restore();

    drawSpinRim();

    if(sc.arrow === 'still'){
      drawStillLabel();
    } else if(sc.arrow){
      drawDriftArrow(sc.arrow, sc.arrow === 'ccw' ? ARROW_RED : ARROW_BLUE);
    }

    ctx.fillStyle = colSub;
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    // Mark count is a modeling choice for clarity (not the real LED count), so show it
    // only as the stride for the sparse printed-pattern scene; plain label otherwise.
    const discCaption = markStep() > 1 ? 'Strobe disc (stride '+markStep()+')' : 'Strobe disc';
    ctx.fillText(discCaption, cx, cy+discR+30);

    if(lit){
      const g = ctx.createRadialGradient(ledX, ledY, 4, cx, cy, discR*1.05);
      const amber = isDark ? '255,210,120' : '250,199,120';
      g.addColorStop(0, 'rgba('+amber+',0.42)');
      g.addColorStop(1, 'rgba('+amber+',0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(ledX, ledY);
      const ang = Math.atan2(cy-ledY, cx-ledX);
      const spread = 0.34;
      ctx.arc(cx, cy, discR*1.12, ang-spread, ang+spread);
      ctx.closePath();
      ctx.fill();
    }

    ctx.beginPath();
    ctx.arc(ledX, ledY, 26, 0, Math.PI*2);
    ctx.fillStyle = isDark ? '#222' : '#d8d6cf';
    ctx.fill();
    ctx.strokeStyle = isDark ? '#55534c' : '#b4b2a9';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(ledX, ledY, 15, 0, Math.PI*2);
    const onCol = '255,176,32';
    const offCol = isDark ? '70,62,40' : '110,100,70';
    ctx.fillStyle = lit ? 'rgb('+onCol+')' : 'rgb('+offCol+')';
    ctx.fill();

    if(lit){
      ctx.beginPath();
      ctx.arc(ledX, ledY, 25, 0, Math.PI*2);
      ctx.strokeStyle = 'rgba('+onCol+',0.5)';
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    ctx.fillStyle = colText;
    ctx.font = '500 13px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Strobe Light', ledX, ledY-36);
    ctx.fillStyle = colSub;
    ctx.font = '12px sans-serif';
    ctx.fillText(continuous ? 'Continuous' : 'Flashing at a fixed rate', ledX, ledY+44);

    const bx = 360, by = 290, bw = 270, bh = 96;
    ctx.fillStyle = isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.03)';
    ctx.beginPath();
    ctx.roundRect(bx, by, bw, bh, 8);
    ctx.fill();

    ctx.textAlign = 'left';
    ctx.fillStyle = colSub;
    ctx.font = '12px sans-serif';
    ctx.fillText('Light', bx+16, by+26);
    ctx.fillText('Rotation speed', bx+16, by+52);
    ctx.fillText('Apparent motion', bx+16, by+78);

    let speedTxt;
    if(sc.speedFactor > 1.0001) speedTxt = 'Slightly fast';
    else if(sc.speedFactor < 0.9999) speedTxt = 'Slightly slow';
    else speedTxt = 'Matched';

    ctx.textAlign = 'right';
    ctx.fillStyle = colText;
    ctx.font = '500 13px sans-serif';
    ctx.fillText(continuous ? 'Continuous' : (lit ? 'Flashing (ON)' : 'Flashing (off)'), bx+bw-16, by+26);
    ctx.fillText(speedTxt, bx+bw-16, by+52);
    ctx.fillStyle = statusFg(sc.motionColor);
    ctx.fillText(sc.motion, bx+bw-16, by+78);
  }

  function update(dt){
    const sc = curScene();
    const angPrev = discAngle;
    discAngle += RAD_PER_S * sc.speedFactor * dt;
    strobePhase += dt;
    while(strobePhase >= FLASH_PERIOD_S){
      strobePhase -= FLASH_PERIOD_S;
    }
    const lit = isLit();

    if(trailOn){
      // Light-accumulation model: add light while lit, fade toward dark otherwise.
      if(lit) accAdd(angPrev, discAngle, dt);
      else accDecay(dt);
      currentBand = null;
    } else {
      // Color-overlay model: a single current band drawn while lit.
      currentBand = lit ? { start: discAngle - RAD_PER_FRAME * sc.speedFactor, end: discAngle } : null;
    }
  }

  function updateFrameInfo(){
    const phaseFrame = Math.round(strobePhase / FRAME_S);
    frameInfo.textContent = 'frame ' + Math.round(frameCount) + '  (phase ' + phaseFrame + '/' + FLASH_PERIOD_FRAMES + ')';
  }

  function syncSceneUI(){
    const sc = curScene();
    sceneLabelEl.textContent = sc.label;
    sceneStatusEl.textContent = sc.status;
    sceneStatusEl.style.background = statusBg(sc.statusColor);
    sceneStatusEl.style.color = statusFg(sc.statusColor);
    sceneDescEl.textContent = sc.desc;
    for(let i=0;i<sceneBtns.length;i++){
      sceneBtns[i].setAttribute('aria-pressed', sceneIdx === i ? 'true' : 'false');
      sceneBtns[i].style.fontWeight = sceneIdx === i ? '600' : '400';
    }
  }

  function loop(ts){
    if(!lastTs) lastTs = ts;
    let dt = (ts - lastTs)/1000;
    lastTs = ts;
    if(dt > 0.2) dt = 0.2;
    if(playing){
      update(dt);
      frameCount += dt / FRAME_S;
      updateFrameInfo();
    }
    draw();
    requestAnimationFrame(loop);
  }

  function setPlayUI(){
    playLabel.textContent = playing ? 'Pause' : 'Play';
    playBtn.querySelector('i').className = playing ? 'ti ti-player-pause' : 'ti ti-player-play';
  }

  function resetState(){
    discAngle = 0;
    strobePhase = 0;
    currentBand = null;
    frameCount = 0;
    accClear();
  }

  playBtn.addEventListener('click', function(){
    playing = !playing;
    setPlayUI();
  });
  stepBtn.addEventListener('click', function(){
    if(playing){
      playing = false;
      setPlayUI();
    }
    update(FRAME_S);
    frameCount = Math.round(frameCount) + 1;
    updateFrameInfo();
    draw();
  });
  resetBtn.addEventListener('click', function(){
    resetState();
    playing = false;
    setPlayUI();
    updateFrameInfo();
    draw();
  });
  trailBtn.addEventListener('click', function(){
    trailOn = !trailOn;
    trailLabel.textContent = trailOn ? 'Afterimage: ON' : 'Afterimage: OFF';
    if(trailOn){
      // Reset the accumulation buffer to the uniform initial color when switching back.
      accClear();
    }
  });
  for(let i=0;i<sceneBtns.length;i++){
    (function(idx){
      sceneBtns[idx].addEventListener('click', function(){
        sceneIdx = idx;
        syncSceneUI();
        draw();
      });
    })(i);
  }

  resetState();
  syncSceneUI();
  updateFrameInfo();

  fitCanvas();
  window.addEventListener('resize', fitCanvas);
  if(window.ResizeObserver){
    const ro = new ResizeObserver(function(){ fitCanvas(); });
    ro.observe(canvasWrap);
  }
  setTimeout(fitCanvas, 60);
  setTimeout(fitCanvas, 250);

  draw();
  requestAnimationFrame(loop);
})();
