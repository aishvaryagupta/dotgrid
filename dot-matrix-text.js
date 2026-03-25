/**
 * DotMatrix Text Library v1.0.0
 *
 * Zero-dependency UMD library for rendering text as animated dot-matrix
 * patterns on canvas. Supports three modes:
 *
 *   static   - Single word, scatter-to-form animation on scroll
 *   cycle    - Inline span cycling between words with crossfade
 *   headline - Full multi-line headline with static + cycling segments
 *
 * Usage:
 *   <span data-dot-matrix="cycle" data-words="ship,build"></span>
 *   <span data-dot-matrix="static" data-word="ending"></span>
 *   <div data-dot-matrix="headline"
 *        data-lines='["Learn to {ship,build} what","you design."]'></div>
 *
 * JS API:
 *   DotMatrix.init()                  // auto-init all [data-dot-matrix]
 *   DotMatrix.create(el, options)     // create instance manually
 *   instance.play() / .pause() / .destroy() / .resize()
 */
(function (root, factory) {
  if (typeof define === 'function' && define.amd) {
    define([], factory);
  } else if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.DotMatrix = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Defaults
  // ---------------------------------------------------------------------------
  var defaults = {
    activeColor:      '#ff5d22',
    inactiveColor:    'rgba(255,93,34,0.15)',
    staticColor:      '#f5f5f7',
    hold:             2500,
    transitionFrames: 14,
    animationFrames:  60,
    trigger:          'viewport', // "viewport" | "immediate" | "manual"
    dotShape:         'circle'    // "circle" | "square" | "diamond" | "triangle" | "star" | "cross"
  };

  // ---------------------------------------------------------------------------
  // CSS injection (once)
  // ---------------------------------------------------------------------------
  var cssInjected = false;
  var CSS_TEXT =
    '[data-dot-matrix]{display:inline-block;vertical-align:baseline;position:relative;margin:0}' +
    '[data-dot-matrix] canvas{display:inline-block;pointer-events:none;vertical-align:-0.25em}' +
    '[data-dot-matrix="headline"]{display:block}' +
    '[data-dot-matrix="headline"] canvas{display:block;vertical-align:baseline}';

  function injectCSS() {
    if (cssInjected) return;
    if (document.querySelector('link[href*="dot-matrix-text.css"]')) {
      cssInjected = true;
      return;
    }
    var style = document.createElement('style');
    style.setAttribute('data-dot-matrix-css', '');
    style.textContent = CSS_TEXT;
    document.head.appendChild(style);
    cssInjected = true;
  }

  // ---------------------------------------------------------------------------
  // Utility helpers
  // ---------------------------------------------------------------------------

  /** Read a data-attribute or fall back to an option or a default. */
  function attr(el, name, opts, fallback) {
    var v = el.getAttribute('data-' + name);
    if (v !== null && v !== '') return v;
    if (opts && opts[camel(name)] !== undefined) return opts[camel(name)];
    return fallback;
  }

  /** kebab-to-camelCase */
  function camel(s) {
    return s.replace(/-([a-z])/g, function (_, c) { return c.toUpperCase(); });
  }

  /** Clamp helper */
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  /** Ease-out cubic */
  function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }

  /** Draw a single dot in the given shape. */
  function drawDot(ctx, cx, cy, rad, shape) {
    switch (shape) {
      case 'square':
        ctx.fillRect(cx - rad, cy - rad, rad * 2, rad * 2);
        return;
      case 'diamond':
        ctx.beginPath();
        ctx.moveTo(cx, cy - rad);
        ctx.lineTo(cx + rad, cy);
        ctx.lineTo(cx, cy + rad);
        ctx.lineTo(cx - rad, cy);
        ctx.closePath();
        ctx.fill();
        return;
      case 'triangle':
        ctx.beginPath();
        ctx.moveTo(cx, cy - rad);
        ctx.lineTo(cx + rad, cy + rad);
        ctx.lineTo(cx - rad, cy + rad);
        ctx.closePath();
        ctx.fill();
        return;
      case 'star':
        ctx.beginPath();
        for (var i = 0; i < 5; i++) {
          var outerAngle = (i * 4 * Math.PI / 5) - Math.PI / 2;
          var innerAngle = outerAngle + 2 * Math.PI / 5;
          if (i === 0) ctx.moveTo(cx + rad * Math.cos(outerAngle), cy + rad * Math.sin(outerAngle));
          else         ctx.lineTo(cx + rad * Math.cos(outerAngle), cy + rad * Math.sin(outerAngle));
          ctx.lineTo(cx + rad * 0.4 * Math.cos(innerAngle), cy + rad * 0.4 * Math.sin(innerAngle));
        }
        ctx.closePath();
        ctx.fill();
        return;
      case 'cross':
        var arm = rad * 0.35;
        ctx.fillRect(cx - arm, cy - rad, arm * 2, rad * 2);
        ctx.fillRect(cx - rad, cy - arm, rad * 2, arm * 2);
        return;
      default: // circle
        ctx.beginPath();
        ctx.arc(cx, cy, rad, 0, Math.PI * 2);
        ctx.fill();
    }
  }

  /** Read computed font properties from an element (or its parent). */
  function readFont(el) {
    var target = el.parentElement || el;
    var cs = getComputedStyle(target);
    return {
      family:   cs.fontFamily || '"Space Grotesk", system-ui, sans-serif',
      weight:   cs.fontWeight || '700',
      size:     parseFloat(cs.fontSize) || 48
    };
  }

  /** Rasterize text onto an offscreen canvas and return pixel data. */
  function rasterize(text, font, w, h, xOffset, yOffset) {
    var off = document.createElement('canvas');
    off.width  = w;
    off.height = h;
    var c = off.getContext('2d');
    c.font = font.weight + ' ' + font.size + 'px ' + font.family;
    c.fillStyle = '#fff';
    c.textBaseline = 'top';
    c.textAlign    = 'left';
    c.fillText(text, xOffset || 0, yOffset || 0);
    return c.getImageData(0, 0, w, h);
  }

  /** Convert imageData into a boolean grid (true = filled dot). */
  function imageDataToGrid(imageData, cols, rows, dotSpacing, w) {
    var grid = [];
    for (var r = 0; r < rows; r++) {
      for (var c = 0; c < cols; c++) {
        var sx = Math.floor(c * dotSpacing + dotSpacing / 2);
        var sy = Math.floor(r * dotSpacing + dotSpacing / 2);
        var i  = (sy * w + sx) * 4;
        grid.push(imageData.data[i + 3] > 80);
      }
    }
    return grid;
  }

  /** Measure text width using an offscreen canvas. */
  function measureText(text, font) {
    var c = document.createElement('canvas').getContext('2d');
    c.font = font.weight + ' ' + font.size + 'px ' + font.family;
    return c.measureText(text).width;
  }

  // ---------------------------------------------------------------------------
  // Instance registry (for global pause / cleanup)
  // ---------------------------------------------------------------------------
  var instances = [];

  // ---------------------------------------------------------------------------
  // Shared IntersectionObserver (viewport visibility tracking)
  // ---------------------------------------------------------------------------
  var visibilityObserver = null;
  var visibilityMap = new Map(); // el -> callback

  function getVisibilityObserver() {
    if (visibilityObserver) return visibilityObserver;
    visibilityObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        var cb = visibilityMap.get(entry.target);
        if (cb) cb(entry.isIntersecting);
      });
    }, { threshold: 0.1 });
    return visibilityObserver;
  }

  function observeVisibility(el, cb) {
    visibilityMap.set(el, cb);
    getVisibilityObserver().observe(el);
  }

  function unobserveVisibility(el) {
    visibilityMap.delete(el);
    if (visibilityObserver) visibilityObserver.unobserve(el);
  }

  // ---------------------------------------------------------------------------
  // Base Instance prototype
  // ---------------------------------------------------------------------------

  function Instance(el, opts) {
    this.el       = el;
    this.opts     = opts || {};
    this.canvas   = null;
    this.ctx      = null;
    this.dpr      = window.devicePixelRatio || 1;
    this.destroyed = false;
    this.paused    = false;
    this.inView    = false;
    this._resizeTimer = null;

    // Resolve configuration
    this.activeColor      = attr(el, 'active-color',      opts, defaults.activeColor);
    this.inactiveColor    = attr(el, 'inactive-color',     opts, defaults.inactiveColor);
    this.staticColor      = attr(el, 'static-color',       opts, defaults.staticColor);
    this.hold             = parseInt(attr(el, 'hold',             opts, defaults.hold), 10);
    this.transitionFrames = parseInt(attr(el, 'transition-frames', opts, defaults.transitionFrames), 10);
    this.animationFrames  = parseInt(attr(el, 'animation-frames',  opts, defaults.animationFrames), 10);
    this.trigger          = attr(el, 'trigger',            opts, defaults.trigger);
    this.dotShape         = attr(el, 'dot-shape',           opts, defaults.dotShape);
  }

  /** Create the canvas element and attach it. */
  Instance.prototype._createCanvas = function () {
    this.canvas = document.createElement('canvas');
    this.ctx    = this.canvas.getContext('2d');
    this.el.innerHTML = '';
    this.el.appendChild(this.canvas);
  };

  /** Size the canvas for a given logical width and height, accounting for HiDPI. */
  Instance.prototype._sizeCanvas = function (w, h) {
    var dpr = this.dpr;
    this.canvas.width       = Math.round(w * dpr);
    this.canvas.height      = Math.round(h * dpr);
    this.canvas.style.width  = w + 'px';
    this.canvas.style.height = h + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };

  /** Set up a ResizeObserver with debounce. */
  Instance.prototype._watchResize = function () {
    var self = this;
    if (typeof ResizeObserver === 'undefined') return;
    this._ro = new ResizeObserver(function () {
      clearTimeout(self._resizeTimer);
      self._resizeTimer = setTimeout(function () {
        if (!self.destroyed) self.resize();
      }, 150);
    });
    this._ro.observe(this.el.parentElement || this.el);
  };

  /** Teardown. */
  Instance.prototype.destroy = function () {
    this.destroyed = true;
    this.paused    = true;
    unobserveVisibility(this.el);
    if (this._ro) this._ro.disconnect();
    clearTimeout(this._resizeTimer);
    clearTimeout(this._holdTimer);
    if (this.canvas && this.canvas.parentNode) {
      this.canvas.parentNode.removeChild(this.canvas);
    }
    var idx = instances.indexOf(this);
    if (idx !== -1) instances.splice(idx, 1);
  };

  Instance.prototype.play  = function () { this.paused = false; };
  Instance.prototype.pause = function () { this.paused = true; };

  // ---------------------------------------------------------------------------
  // STATIC MODE
  // ---------------------------------------------------------------------------

  function StaticInstance(el, opts) {
    Instance.call(this, el, opts);
    this.word     = attr(el, 'word', opts, '');
    this.animated = false;
    this._setup();
  }
  StaticInstance.prototype = Object.create(Instance.prototype);
  StaticInstance.prototype.constructor = StaticInstance;

  StaticInstance.prototype._setup = function () {
    var self = this;
    this._createCanvas();
    this._watchResize();
    this._build();

    // Viewport trigger
    if (this.trigger === 'immediate') {
      this._playAnimation();
    } else if (this.trigger === 'viewport') {
      var triggerObserver = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            self._playAnimation();
            triggerObserver.unobserve(self.el);
          }
        });
      }, { threshold: 0.3 });
      triggerObserver.observe(this.el);
      this._triggerObserver = triggerObserver;
    }
    // "manual" — user calls instance.play() which sets paused=false,
    // then they can call instance._playAnimation() or we expose it via play().
  };

  StaticInstance.prototype.play = function () {
    this.paused = false;
    if (!this.animated) this._playAnimation();
  };

  StaticInstance.prototype._build = function () {
    if (!this.word) return;
    var font = readFont(this.el);
    this.font = font;
    var fontSize = font.size;

    this.dotSpacing = Math.max(4, Math.round(fontSize / 14));
    this.dotRadius  = this.dotSpacing * 0.36;

    var wordWidth = measureText(this.word, font);
    this.cols = Math.ceil(wordWidth / this.dotSpacing);
    this.rows = Math.ceil((fontSize * 1.0) / this.dotSpacing);
    this.logicalW = this.cols * this.dotSpacing;
    this.logicalH = this.rows * this.dotSpacing;

    this._sizeCanvas(this.logicalW, this.logicalH);

    // Rasterize
    var yOffset = (this.logicalH - fontSize) / 2;
    var imgData = rasterize(this.word, font, this.logicalW, this.logicalH, 0, yOffset);
    this.allDots = [];
    this.targetPositions = [];
    for (var r = 0; r < this.rows; r++) {
      for (var c = 0; c < this.cols; c++) {
        var sx = Math.floor(c * this.dotSpacing + this.dotSpacing / 2);
        var sy = Math.floor(r * this.dotSpacing + this.dotSpacing / 2);
        var i  = (sy * this.logicalW + sx) * 4;
        var active = imgData.data[i + 3] > 80;
        this.allDots.push(active);
        if (active) this.targetPositions.push({ col: c, row: r });
      }
    }

    // Scattered starting positions
    var w = this.logicalW, h = this.logicalH;
    this.scatteredPositions = this.targetPositions.map(function () {
      return {
        x: (Math.random() - 0.5) * w * 1.5 + w / 2,
        y: (Math.random() - 0.5) * h * 1.5 + h / 2
      };
    });

    // Draw background grid
    this._drawGrid();
  };

  StaticInstance.prototype._drawGrid = function () {
    var ctx = this.ctx, sp = this.dotSpacing, rad = this.dotRadius, shape = this.dotShape;
    ctx.clearRect(0, 0, this.logicalW, this.logicalH);
    for (var r = 0; r < this.rows; r++) {
      for (var c = 0; c < this.cols; c++) {
        var cx = c * sp + sp / 2;
        var cy = r * sp + sp / 2;
        ctx.fillStyle   = this.inactiveColor;
        ctx.globalAlpha = 1;
        drawDot(ctx, cx, cy, rad, shape);
      }
    }
  };

  StaticInstance.prototype._drawFinal = function () {
    this._drawGrid();
    var ctx = this.ctx, sp = this.dotSpacing, rad = this.dotRadius, shape = this.dotShape;
    for (var r = 0; r < this.rows; r++) {
      for (var c = 0; c < this.cols; c++) {
        if (this.allDots[r * this.cols + c]) {
          var cx = c * sp + sp / 2;
          var cy = r * sp + sp / 2;
          ctx.fillStyle   = this.activeColor;
          ctx.globalAlpha = 1;
          drawDot(ctx, cx, cy, rad, shape);
        }
      }
    }
  };

  StaticInstance.prototype._playAnimation = function () {
    if (this.animated || this.destroyed) return;
    this.animated = true;
    var self = this;
    var frame = 0;
    var total = this.animationFrames;
    var sp = this.dotSpacing, rad = this.dotRadius, shape = this.dotShape;

    function step() {
      if (self.destroyed) return;
      frame++;
      var progress = frame / total;
      var eased    = easeOutCubic(progress);

      self._drawGrid();

      for (var i = 0; i < self.targetPositions.length; i++) {
        var t   = self.targetPositions[i];
        var s   = self.scatteredPositions[i];
        var fx  = t.col * sp + sp / 2;
        var fy  = t.row * sp + sp / 2;
        var cx  = s.x + (fx - s.x) * eased;
        var cy  = s.y + (fy - s.y) * eased;

        self.ctx.fillStyle   = self.activeColor;
        self.ctx.globalAlpha = Math.min(1, eased * 1.5);
        drawDot(self.ctx, cx, cy, rad, shape);
      }
      self.ctx.globalAlpha = 1;

      if (frame < total) {
        requestAnimationFrame(step);
      } else {
        self._drawFinal();
      }
    }
    requestAnimationFrame(step);
  };

  StaticInstance.prototype.resize = function () {
    this.animated = false;
    this._build();
    // Re-trigger if already scrolled past
    if (this.trigger === 'immediate') {
      this._playAnimation();
    }
  };

  // ---------------------------------------------------------------------------
  // CYCLE MODE
  // ---------------------------------------------------------------------------

  function CycleInstance(el, opts) {
    Instance.call(this, el, opts);
    var raw = attr(el, 'words', opts, '');
    this.words = raw.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    this.currentIndex = 0;
    this.grids = {};
    this._holdTimer = null;
    this._cycling = false;
    this._setup();
  }
  CycleInstance.prototype = Object.create(Instance.prototype);
  CycleInstance.prototype.constructor = CycleInstance;

  CycleInstance.prototype._setup = function () {
    this._createCanvas();
    this._watchResize();
    this._build();

    // Track viewport visibility to pause off-screen
    var self = this;
    observeVisibility(this.el, function (visible) {
      self.inView = visible;
    });
    this.inView = true; // assume visible initially
  };

  CycleInstance.prototype._build = function () {
    if (!this.words.length) return;
    var font = readFont(this.el);
    this.font = font;
    var fontSize = font.size;

    this.dotSpacing = Math.max(4, Math.round(fontSize / 14));
    this.dotRadius  = this.dotSpacing * 0.36;

    // Measure widest word
    var self = this;
    var maxWidth = 0;
    this.words.forEach(function (w) {
      var ww = measureText(w, font);
      if (ww > maxWidth) maxWidth = ww;
    });

    this.cols = Math.ceil(maxWidth / this.dotSpacing);
    this.rows = Math.ceil((fontSize * 1.0) / this.dotSpacing);
    this.logicalW = this.cols * this.dotSpacing;
    this.logicalH = this.rows * this.dotSpacing;

    this._sizeCanvas(this.logicalW, this.logicalH);

    // Build grids for each word
    var yOffset = (this.logicalH - fontSize) / 2;
    this.grids = {};
    this.words.forEach(function (w) {
      var img = rasterize(w, font, self.logicalW, self.logicalH, 0, yOffset);
      self.grids[w] = imageDataToGrid(img, self.cols, self.rows, self.dotSpacing, self.logicalW);
    });

    // Draw initial word
    this._drawWord(this.grids[this.words[this.currentIndex]]);

    // Start cycling
    this._startCycle();
  };

  CycleInstance.prototype._drawWord = function (grid) {
    var ctx = this.ctx, sp = this.dotSpacing, rad = this.dotRadius, shape = this.dotShape;
    var cols = this.cols, rows = this.rows;
    ctx.clearRect(0, 0, this.logicalW, this.logicalH);

    for (var r = 0; r < rows; r++) {
      for (var c = 0; c < cols; c++) {
        var idx = r * cols + c;
        var cx  = c * sp + sp / 2;
        var cy  = r * sp + sp / 2;

        // Background dot (always visible)
        ctx.fillStyle   = this.inactiveColor;
        ctx.globalAlpha = 1;
        drawDot(ctx, cx, cy, rad, shape);

        // Active dot on top
        if (grid[idx]) {
          ctx.fillStyle   = this.activeColor;
          ctx.globalAlpha = 1;
          drawDot(ctx, cx, cy, rad, shape);
        }
      }
    }
  };

  CycleInstance.prototype._startCycle = function () {
    clearTimeout(this._holdTimer);
    var self = this;
    this._holdTimer = setTimeout(function () { self._cycle(); }, this.hold);
  };

  CycleInstance.prototype._cycle = function () {
    if (this.destroyed) return;
    if (this.paused || !this.inView) {
      // Retry after hold period
      var self = this;
      this._holdTimer = setTimeout(function () { self._cycle(); }, this.hold);
      return;
    }

    var fromWord  = this.words[this.currentIndex];
    var nextIndex = (this.currentIndex + 1) % this.words.length;
    var toWord    = this.words[nextIndex];
    var fromGrid  = this.grids[fromWord];
    var toGrid    = this.grids[toWord];

    var self  = this;
    var frame = 0;
    var total = this.transitionFrames;
    var cols  = this.cols, rows = this.rows;
    var sp = this.dotSpacing, rad = this.dotRadius, shape = this.dotShape;
    var numDots = cols * rows;

    // Per-dot stagger delays
    var delays = [];
    for (var i = 0; i < numDots; i++) delays.push(Math.random() * 0.5);

    function step() {
      if (self.destroyed) return;
      frame++;
      var progress = frame / total;
      var ctx = self.ctx;
      ctx.clearRect(0, 0, self.logicalW, self.logicalH);

      for (var r = 0; r < rows; r++) {
        for (var c = 0; c < cols; c++) {
          var idx = r * cols + c;
          var cx  = c * sp + sp / 2;
          var cy  = r * sp + sp / 2;
          var localT = clamp((progress - delays[idx]) / 0.5, 0, 1);

          var wasActive  = fromGrid[idx];
          var willActive = toGrid[idx];
          var opacity = 0;
          if (wasActive && willActive)        opacity = 1;
          else if (wasActive && !willActive)  opacity = 1 - localT;
          else if (!wasActive && willActive)  opacity = localT;

          // Inactive background dot
          ctx.fillStyle   = self.inactiveColor;
          ctx.globalAlpha = 1;
          drawDot(ctx, cx, cy, rad, shape);

          // Active dot
          if (opacity > 0.01) {
            ctx.fillStyle   = self.activeColor;
            ctx.globalAlpha = opacity;
            drawDot(ctx, cx, cy, rad, shape);
          }
          ctx.globalAlpha = 1;
        }
      }

      if (frame < total) {
        requestAnimationFrame(step);
      } else {
        self.currentIndex = nextIndex;
        self._drawWord(self.grids[self.words[self.currentIndex]]);
        self._startCycle();
      }
    }
    requestAnimationFrame(step);
  };

  CycleInstance.prototype.resize = function () {
    clearTimeout(this._holdTimer);
    this._build();
  };

  // ---------------------------------------------------------------------------
  // HEADLINE MODE
  // ---------------------------------------------------------------------------

  function HeadlineInstance(el, opts) {
    Instance.call(this, el, opts);

    // Parse data-lines JSON
    var raw = attr(el, 'lines', opts, '[]');
    try { this.lines = JSON.parse(raw); } catch (e) { this.lines = []; }

    this.currentIndex = 0;
    this.wordGrids = {};
    this._holdTimer = null;
    this._setup();
  }
  HeadlineInstance.prototype = Object.create(Instance.prototype);
  HeadlineInstance.prototype.constructor = HeadlineInstance;

  HeadlineInstance.prototype._setup = function () {
    this._createCanvas();
    this._watchResize();
    this._build();

    var self = this;
    observeVisibility(this.el, function (visible) {
      self.inView = visible;
    });
    this.inView = true;
  };

  /**
   * Parse lines to identify static text and the cycling segment.
   * A cycling segment is marked as {word1,word2,...} inside a line.
   * Returns:
   *   this.parsedLines - array of { segments: [{ text, type:'static'|'cycle', words? }] }
   *   this.cycleWords  - array of words that cycle
   */
  HeadlineInstance.prototype._parseLines = function () {
    var cycleWords = null;
    var parsed = this.lines.map(function (line) {
      var segments = [];
      var re = /\{([^}]+)\}/g;
      var lastIdx = 0;
      var match;
      while ((match = re.exec(line)) !== null) {
        // Static text before the match
        if (match.index > lastIdx) {
          segments.push({ text: line.slice(lastIdx, match.index), type: 'static' });
        }
        var words = match[1].split(',').map(function (s) { return s.trim(); });
        segments.push({ type: 'cycle', words: words });
        if (!cycleWords) cycleWords = words;
        lastIdx = re.lastIndex;
      }
      // Remaining static text
      if (lastIdx < line.length) {
        segments.push({ text: line.slice(lastIdx), type: 'static' });
      }
      return { segments: segments };
    });
    this.parsedLines = parsed;
    this.cycleWords  = cycleWords || [];
  };

  HeadlineInstance.prototype._build = function () {
    if (!this.lines.length) return;
    this._parseLines();

    // Determine font — for headline mode, read from the element itself or parent
    var cs = getComputedStyle(this.el);
    var parentFontSize = parseFloat(cs.fontSize);
    // If the element has no meaningful size yet, use parent
    if (!parentFontSize || parentFontSize < 10) {
      parentFontSize = parseFloat(getComputedStyle(this.el.parentElement).fontSize) || 48;
    }

    // For headline mode, allow container-based sizing like the original
    var containerWidth = this.el.offsetWidth || (this.el.parentElement ? this.el.parentElement.offsetWidth : 800);
    // Use the computed font size directly (CSS clamp / vw should already handle responsiveness)
    var fontSize = parentFontSize;

    var font = {
      family: cs.fontFamily || '"Space Grotesk", system-ui, sans-serif',
      weight: cs.fontWeight || '700',
      size:   fontSize
    };
    this.font = font;

    this.dotSpacing = Math.max(4, Math.round(fontSize / 14));
    this.dotRadius  = this.dotSpacing * 0.36;

    var sp = this.dotSpacing;
    var lineHeight   = fontSize * 1.0;
    var rowsPerLine  = Math.ceil(lineHeight / sp);
    var lineGap      = Math.ceil((fontSize * 0.15) / sp);
    var totalRows    = rowsPerLine * this.lines.length + lineGap * (this.lines.length - 1);

    // Measure widest line (considering all cycle-word variants)
    var self = this;
    var maxWidth = 0;

    function measureLineVariant(parsedLine, wordVariant) {
      var text = '';
      parsedLine.segments.forEach(function (seg) {
        if (seg.type === 'static') text += seg.text;
        else text += wordVariant;
      });
      return measureText(text, font);
    }

    this.parsedLines.forEach(function (pl) {
      if (self.cycleWords.length) {
        self.cycleWords.forEach(function (w) {
          var lw = measureLineVariant(pl, w);
          if (lw > maxWidth) maxWidth = lw;
        });
      } else {
        var lw = measureLineVariant(pl, '');
        if (lw > maxWidth) maxWidth = lw;
      }
    });

    this.cols = Math.ceil(maxWidth / sp) + 1;
    this.rows = totalRows;
    this.logicalW    = this.cols * sp;
    this.logicalH    = this.rows * sp;
    this.rowsPerLine = rowsPerLine;
    this.lineGap     = lineGap;

    this._sizeCanvas(this.logicalW, this.logicalH);

    // Build the static grid (all non-cycling text)
    this.staticGrid = this._buildStaticGrid();

    // Build word-specific grids (only the cycling segment dots)
    this.wordGrids = {};
    if (this.cycleWords.length) {
      var cSelf = this;
      this.cycleWords.forEach(function (w) {
        cSelf.wordGrids[w] = cSelf._buildCycleWordGrid(w);
      });
    }

    // Initial draw
    this._draw(this.cycleWords.length ? this.wordGrids[this.cycleWords[this.currentIndex]] : null);

    // Start cycling if there are words to cycle
    if (this.cycleWords.length > 1) {
      this._startCycle();
    }
  };

  /** Build the boolean grid for all static (non-cycling) text across all lines. */
  HeadlineInstance.prototype._buildStaticGrid = function () {
    var font = this.font, sp = this.dotSpacing;
    var w = this.logicalW, h = this.logicalH;
    var cols = this.cols, rows = this.rows;
    var rowsPerLine = this.rowsPerLine, lineGap = this.lineGap;
    var combined = new Array(cols * rows);
    for (var i = 0; i < combined.length; i++) combined[i] = false;

    var self = this;
    this.parsedLines.forEach(function (pl, lineIdx) {
      var yBase = lineIdx * (rowsPerLine + lineGap) * sp;
      var yOffset = yBase + (rowsPerLine * sp - font.size) / 2;

      // Build the static text for this line (cycle segments replaced with spaces of max word width)
      var xCursor = 0;
      pl.segments.forEach(function (seg) {
        if (seg.type === 'static') {
          var img = rasterize(seg.text, font, w, h, xCursor, yOffset);
          var grid = imageDataToGrid(img, cols, rows, sp, w);
          for (var j = 0; j < grid.length; j++) {
            if (grid[j]) combined[j] = true;
          }
          xCursor += measureText(seg.text, font);
        } else {
          // Skip over the widest cycle word width (leave space for orange dots)
          var maxW = 0;
          seg.words.forEach(function (cw) {
            var ww = measureText(cw, font);
            if (ww > maxW) maxW = ww;
          });
          xCursor += maxW;
        }
      });
    });

    return combined;
  };

  /** Build the boolean grid for one variant of the cycling word. */
  HeadlineInstance.prototype._buildCycleWordGrid = function (word) {
    var font = this.font, sp = this.dotSpacing;
    var w = this.logicalW, h = this.logicalH;
    var cols = this.cols, rows = this.rows;
    var rowsPerLine = this.rowsPerLine, lineGap = this.lineGap;
    var combined = new Array(cols * rows);
    for (var i = 0; i < combined.length; i++) combined[i] = false;

    var self = this;
    this.parsedLines.forEach(function (pl, lineIdx) {
      var yBase = lineIdx * (rowsPerLine + lineGap) * sp;
      var yOffset = yBase + (rowsPerLine * sp - font.size) / 2;
      var xCursor = 0;

      pl.segments.forEach(function (seg) {
        if (seg.type === 'static') {
          xCursor += measureText(seg.text, font);
        } else {
          // Rasterize the specific word at the correct x position
          var img = rasterize(word, font, w, h, xCursor, yOffset);
          var grid = imageDataToGrid(img, cols, rows, sp, w);
          for (var j = 0; j < grid.length; j++) {
            if (grid[j]) combined[j] = true;
          }
          // Advance cursor by widest word width (to keep suffix aligned)
          var maxW = 0;
          seg.words.forEach(function (cw) {
            var ww = measureText(cw, font);
            if (ww > maxW) maxW = ww;
          });
          xCursor += maxW;
        }
      });
    });

    return combined;
  };

  /** Draw the full headline: static dots in staticColor, word dots in activeColor. */
  HeadlineInstance.prototype._draw = function (wordGrid, transFromGrid, transToGrid, delays, progress) {
    var ctx  = this.ctx;
    var cols = this.cols, rows = this.rows;
    var sp   = this.dotSpacing, rad = this.dotRadius, shape = this.dotShape;
    var w    = this.logicalW, h = this.logicalH;

    ctx.clearRect(0, 0, w, h);

    for (var r = 0; r < rows; r++) {
      for (var c = 0; c < cols; c++) {
        var idx = r * cols + c;
        var cx  = c * sp + sp / 2;
        var cy  = r * sp + sp / 2;

        var isStatic = this.staticGrid[idx];

        // No background grid dots in headline mode (transparent inactive)

        // Static dots (white/staticColor)
        if (isStatic) {
          ctx.fillStyle   = this.staticColor;
          ctx.globalAlpha = 1;
          drawDot(ctx, cx, cy, rad, shape);
        }

        // Cycling word dots (orange/activeColor)
        if (transFromGrid && transToGrid && delays && progress !== undefined) {
          var localT = clamp((progress - delays[idx]) / 0.5, 0, 1);
          var wasActive  = transFromGrid[idx];
          var willActive = transToGrid[idx];
          var opacity = 0;
          if (wasActive && willActive)        opacity = 1;
          else if (wasActive && !willActive)  opacity = 1 - localT;
          else if (!wasActive && willActive)  opacity = localT;

          if (opacity > 0.01) {
            ctx.fillStyle   = this.activeColor;
            ctx.globalAlpha = opacity;
            drawDot(ctx, cx, cy, rad, shape);
          }
        } else if (wordGrid && wordGrid[idx]) {
          ctx.fillStyle   = this.activeColor;
          ctx.globalAlpha = 1;
          drawDot(ctx, cx, cy, rad, shape);
        }

        ctx.globalAlpha = 1;
      }
    }
  };

  HeadlineInstance.prototype._startCycle = function () {
    clearTimeout(this._holdTimer);
    var self = this;
    this._holdTimer = setTimeout(function () { self._cycle(); }, this.hold);
  };

  HeadlineInstance.prototype._cycle = function () {
    if (this.destroyed) return;
    if (this.paused || !this.inView) {
      var self = this;
      this._holdTimer = setTimeout(function () { self._cycle(); }, this.hold);
      return;
    }

    var fromWord  = this.cycleWords[this.currentIndex];
    var nextIndex = (this.currentIndex + 1) % this.cycleWords.length;
    var toWord    = this.cycleWords[nextIndex];
    var fromGrid  = this.wordGrids[fromWord];
    var toGrid    = this.wordGrids[toWord];

    var self  = this;
    var frame = 0;
    var total = this.transitionFrames;
    var numDots = this.cols * this.rows;

    var delays = [];
    for (var i = 0; i < numDots; i++) delays.push(Math.random() * 0.5);

    function step() {
      if (self.destroyed) return;
      frame++;
      var progress = frame / total;
      self._draw(null, fromGrid, toGrid, delays, progress);

      if (frame < total) {
        requestAnimationFrame(step);
      } else {
        self.currentIndex = nextIndex;
        self._draw(self.wordGrids[self.cycleWords[self.currentIndex]]);
        self._startCycle();
      }
    }
    requestAnimationFrame(step);
  };

  HeadlineInstance.prototype.resize = function () {
    clearTimeout(this._holdTimer);
    this._build();
  };

  // ---------------------------------------------------------------------------
  // Factory
  // ---------------------------------------------------------------------------

  function createInstance(el, opts) {
    var mode = (el.getAttribute('data-dot-matrix') || '').toLowerCase();
    if (opts && opts.mode) mode = opts.mode;

    var inst;
    switch (mode) {
      case 'static':
        inst = new StaticInstance(el, opts);
        break;
      case 'headline':
        inst = new HeadlineInstance(el, opts);
        break;
      case 'cycle':
      default:
        inst = new CycleInstance(el, opts);
        break;
    }
    instances.push(inst);
    return inst;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  var DotMatrix = {
    defaults: defaults,

    /**
     * Create a dot-matrix instance on a given element.
     * @param {HTMLElement} el
     * @param {Object} [opts]
     * @returns {Instance}
     */
    create: function (el, opts) {
      injectCSS();
      return createInstance(el, opts);
    },

    /**
     * Auto-initialize all [data-dot-matrix] elements on the page.
     * Waits for document.fonts.ready before rasterizing.
     */
    init: function () {
      injectCSS();
      var els = document.querySelectorAll('[data-dot-matrix]');
      if (!els.length) return;

      // Wait for fonts to be ready before building canvases
      var fontsReady = (document.fonts && document.fonts.ready)
        ? document.fonts.ready
        : Promise.resolve();

      fontsReady.then(function () {
        for (var i = 0; i < els.length; i++) {
          // Skip elements that already have an instance
          if (els[i]._dotMatrixInstance) continue;
          var inst = createInstance(els[i]);
          els[i]._dotMatrixInstance = inst;
        }
      });
    },

    /** All active instances. */
    instances: instances
  };

  // Auto-init on DOMContentLoaded
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { DotMatrix.init(); });
  } else {
    // DOM already loaded — defer slightly to let fonts load
    DotMatrix.init();
  }

  return DotMatrix;
}));
