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

    // Build grids for each word (center-aligned within the canvas)
    var yOffset = (this.logicalH - fontSize) / 2;
    this.grids = {};
    this.words.forEach(function (w) {
      var wordWidth = measureText(w, font);
      var xOffset = (self.logicalW - wordWidth) / 2;
      var img = rasterize(w, font, self.logicalW, self.logicalH, xOffset, yOffset);
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
  // PATTERN MODE
  //
  // Algorithmic dot-grid patterns (bricks, ripple, rain, waveforms, noise,
  // radial, numerals). Inspired by the dot-matrix system on buildanything.so:
  // each dot has a phase-offset `delay` driving a global 3-second triangle-wave
  // pulse, which produces coordinated wave motion instead of random shimmer.
  //
  // Usage:
  //   <div data-dot-matrix="pattern"
  //        data-variant="bricks"
  //        data-grid="background"></div>
  //
  // Variants are registered in `patternVariants` and can be extended at runtime
  // via `DotMatrix.patterns.register(name, fn)`.
  // ---------------------------------------------------------------------------

  /** Seeded linear-congruential generator. Deterministic 0..1 stream per seed. */
  function lcgRng(seed) {
    var e = seed || 1;
    return function () { return ((e = (16807 * e) % 0x7fffffff) - 1) / 0x7ffffffe; };
  }

  /** Discrete intensity ladder (0..4 → 0..1). */
  var INTENSITY = { 0: 0, 1: 0.2, 2: 0.45, 3: 0.7, 4: 1 };

  /** Build a Dot record for the variant output list. */
  function makeDot(col, row, intensity, delay, grid) {
    var opacity = INTENSITY[intensity] || 0;
    return {
      col: col,
      row: row,
      x: grid.padX + col * 10,          // laid out on a 10-unit grid
      y: grid.padY + row * 10,
      opacity: opacity,
      minOpacity: Math.round(0.45 * opacity * 1e3) / 1e3,
      delay: Math.round(delay * 1e3) / 1e3,
      lift: 0
    };
  }

  /** Asymmetric Gaussian-ish bump. */
  function gaussBump(t, center, sigmaL, sigmaR) {
    return Math.exp(-Math.pow(t - center, 2) / (t < center ? sigmaL : sigmaR));
  }

  /** Pre-roll an RNG into an array of `n` floats. */
  function prerollNoise(seed, n) {
    var rng = lcgRng(seed);
    var a = new Array(n);
    for (var i = 0; i < n; i++) a[i] = rng();
    return a;
  }

  /** Phase-offset triangle-wave pulse: 0.12 ramp up, 0.18 ramp down, 0.70 rest. */
  function pulseOpacity(dot, tSec) {
    var phase = ((((tSec - dot.delay) % 3) + 3) % 3) / 3;
    if (phase < 0.12) return dot.minOpacity + (dot.opacity - dot.minOpacity) * (phase / 0.12);
    if (phase < 0.30) return dot.opacity + (dot.minOpacity - dot.opacity) * ((phase - 0.12) / 0.18);
    return dot.minOpacity;
  }

  /** Same phase, returns the "lift" bounce (0..lift) at peak. */
  function pulseLift(dot, tSec) {
    if (!dot.lift) return 0;
    var phase = ((((tSec - dot.delay) % 3) + 3) % 3) / 3;
    if (phase < 0.12) return dot.lift * (phase / 0.12);
    if (phase < 0.30) return dot.lift * (1 - (phase - 0.12) / 0.18);
    return 0;
  }

  // ---- Grid presets ---------------------------------------------------------
  var patternGrids = {
    graphic:    { cols: 48,  rows: 30, padX: 1,   padY: 2.5 },
    background: { cols: 128, rows: 60, padX: 2,   padY: 2   },
    badge:      { cols: 19,  rows: 19, padX: 2,   padY: 2   },
    card:       { cols: 35,  rows: 19, padX: 2,   padY: 2   }
  };

  // ---- Variant library ------------------------------------------------------
  var patternVariants = {
    /**
     * bricks — brick-wall silhouette with height profile sin(x*π), every 5th column
     * is a mortar gap. Each dot has a small `lift` so the peak pulse makes it bounce,
     * and `delay` is col-dependent so waves travel along the top edge.
     */
    bricks: function (grid) {
      var rng = lcgRng(101);
      var noise = prerollNoise(101, grid.cols);
      var dots = [];
      var heights = [];
      for (var c = 0; c < grid.cols; c++) {
        var base = Math.floor(0.4 * grid.rows) +
          Math.floor(Math.floor(0.27 * grid.rows) *
            Math.sin((c / (grid.cols - 1)) * Math.PI));
        heights[c] = Math.max(4, Math.min(grid.rows, base + Math.floor(5 * rng()) - 2));
      }
      for (var r = 0; r < grid.rows; r++) {
        var invR = grid.rows - 1 - r;
        var shift = r % 2 === 0 ? 0 : 3; // staggered brick offsets
        for (var c2 = 0; c2 < grid.cols; c2++) {
          if (r >= heights[c2] || (c2 + shift) % 5 >= 4) continue;
          var h = r / Math.max(heights[c2] - 1, 1);
          var level = h < 0.3 ? 4 : h < 0.55 ? 3 : h < 0.8 ? 2 : 1;
          if (rng() > 0.95) level = Math.max(1, level - 1);
          var delay = 3 * noise[c2] + 0.6 * (r / Math.max(heights[c2] - 1, 1));
          var dot = makeDot(c2, invR, level, delay, grid);
          dot.lift = 1;
          dots.push(dot);
        }
      }
      return dots;
    },

    /**
     * ripple — concentric circles emanating from below-center. `delay ∝ distance`,
     * so pulses radiate outward.
     */
    ripple: function (grid) {
      var dots = [];
      var cx = (grid.cols - 1) / 2;
      var cy = grid.rows + Math.floor(0.15 * grid.rows);
      var maxD = Math.sqrt(cx * cx + cy * cy);
      for (var r = 0; r < grid.rows; r++) {
        for (var c = 0; c < grid.cols; c++) {
          var dx = c - cx, dy = r - cy;
          var d = Math.sqrt(dx * dx + dy * dy) / maxD;
          if (d > 0.9) continue;
          var u = 1 - d;
          var level = u > 0.75 ? 4 : u > 0.55 ? 3 : u > 0.35 ? 2 : u > 0.15 ? 1 : 0;
          if (!level) continue;
          dots.push(makeDot(c, r, level, 3 * d * 0.6, grid));
        }
      }
      return dots;
    },

    /**
     * rain — sparse vertical streaks. 40% of columns get a primary streak, a
     * second pass adds short sparkle streaks on top.
     */
    rain: function (grid) {
      var rng = lcgRng(801);
      var dots = [];
      for (var c = 0; c < grid.cols; c++) {
        if (rng() > 0.4) continue;
        var len    = 3 + Math.floor(rng() * (0.6 * grid.rows));
        var start  = Math.floor(rng() * (grid.rows - len));
        var offset = 3 * rng();
        var span   = 0.8 + 1.5 * rng();
        for (var i = 0; i < len; i++) {
          var r = start + i;
          if (r >= grid.rows) break;
          var h = i / len;
          var level = h < 0.1 ? 4 : h < 0.3 ? 3 : h < 0.6 ? 2 : 1;
          dots.push(makeDot(c, r, level, offset + (i / len) * span, grid));
        }
      }
      for (var c2 = 0; c2 < grid.cols; c2++) {
        if (rng() > 0.2) continue;
        var sLen = 2 + Math.floor(5 * rng());
        var sStart = Math.floor(rng() * grid.rows);
        var sOff   = 3 * rng();
        for (var j = 0; j < sLen; j++) {
          var rr = sStart + j;
          if (rr >= grid.rows) break;
          var lvl = j === 0 ? 3 : j === 1 ? 2 : 1;
          dots.push(makeDot(c2, rr, lvl, sOff + 0.15 * j, grid));
        }
      }
      return dots;
    },

    /**
     * waveform-a — audio-waveform silhouette using summed sines. `m()` below fills
     * a column from the bottom up to `h` rows, with the top 15% at peak intensity.
     */
    'waveform-a': function (grid) {
      var rng = lcgRng(901);
      var noise = prerollNoise(901, grid.cols);
      var dots = [];
      for (var c = 0; c < grid.cols; c++) {
        var t = c / (grid.cols - 1);
        var h = Math.floor(
          2 + Math.max(0,
            (Math.sin(t * Math.PI) +
             0.4 * Math.sin(t * Math.PI * 3 + 0.5) +
             0.2 * Math.sin(t * Math.PI * 7 + 1.2)) / 1.6
          ) * (0.75 * grid.rows) + 2 * rng()
        );
        fillColumn(dots, grid, c, h, noise);
      }
      return dots;
    },

    /**
     * noise — fractal value-noise field, 3 octaves, thresholded into the
     * 5-level intensity ladder. Produces organic cloud-like texture.
     */
    noise: function (grid) {
      var dots = [];
      var noise = prerollNoise(1001, grid.cols);
      for (var r = 0; r < grid.rows; r++) {
        for (var c = 0; c < grid.cols; c++) {
          var n = fractalNoise(0.12 * c, 0.12 * r, 3);
          var level = n > 0.65 ? 4 : n > 0.5 ? 3 : n > 0.35 ? 2 : n > 0.22 ? 1 : 0;
          if (!level) continue;
          dots.push(makeDot(c, r, level, 3 * noise[c] + (r / grid.rows) * 0.6, grid));
        }
      }
      return dots;
    },

    /**
     * radial — sunburst of spokes emanating from bottom-center. Creates a
     * searchlight/fan effect.
     */
    radial: function (grid) {
      var rng = lcgRng(701);
      var dots = [];
      var cx = (grid.cols - 1) / 2;
      var cy = grid.rows + 5;
      var step = (2 * Math.PI) / 24;
      for (var r = 0; r < grid.rows; r++) {
        for (var c = 0; c < grid.cols; c++) {
          var dx = c - cx, dy = cy - r;
          var ang = Math.atan2(dx, dy);
          var dist = Math.sqrt(dx * dx + dy * dy);
          var nearest = Math.round(ang / step) * step;
          if (Math.abs(ang - nearest) > 0.06) continue;
          var w = dist / Math.sqrt(cx * cx + cy * cy);
          var level = w < 0.3 ? 4 : w < 0.5 ? 3 : w < 0.75 ? 2 : 1;
          if (w > 0.6 && 0.3 > rng()) continue;
          var delay = 0.6 * w + (ang / Math.PI + 1) * 0.5;
          dots.push(makeDot(c, r, level, delay, grid));
        }
      }
      return dots;
    },

    /**
     * rings — concentric square rings from the grid center, every 3rd ring
     * skipped so bands are visible. Delay grows with ring radius for an
     * outward pulse sweep.
     */
    rings: function (grid) {
      var dots = [];
      var noise = prerollNoise(601, grid.cols);
      var cx = (grid.cols - 1) / 2;
      var cy = (grid.rows - 1) / 2;
      var maxD = Math.max(cx, cy);
      for (var r = 0; r < grid.rows; r++) {
        for (var c = 0; c < grid.cols; c++) {
          var d = Math.max(Math.abs(c - cx), Math.abs(r - cy));
          if (Math.floor(d) % 3 === 1) continue; // gaps between rings
          var n = d / maxD;
          var level = n < 0.2 ? 4 : n < 0.4 ? 3 : n < 0.7 ? 2 : 1;
          var delay = (d / maxD) * 3 * 0.8 + 0.3 * noise[c];
          dots.push(makeDot(c, r, level, delay, grid));
        }
      }
      return dots;
    },

    /**
     * network — random "nodes" scattered on the grid, connected to 2 nearest
     * neighbours via rectilinear edges (like a chip trace). Plus random sparks.
     */
    network: function (grid) {
      var rng = lcgRng(1101);
      var dots = [];
      var noise = prerollNoise(1101, grid.cols);
      var mask = [];
      for (var r = 0; r < grid.rows; r++) {
        mask[r] = [];
        for (var c = 0; c < grid.cols; c++) mask[r][c] = 0;
      }

      // Scatter nodes (and their 4-neighbours).
      var nodeCount = Math.round((18 * (grid.cols * grid.rows)) / 1440);
      var nodes = [];
      for (var n = 0; n < nodeCount; n++) {
        var nc = 2 + Math.floor(rng() * (grid.cols - 4));
        var nr = 2 + Math.floor(rng() * (grid.rows - 4));
        var cross = [[0, 0], [-1, 0], [1, 0], [0, -1], [0, 1]];
        for (var k = 0; k < cross.length; k++) {
          var rr = nr + cross[k][0];
          var cc = nc + cross[k][1];
          if (rr >= 0 && rr < grid.rows && cc >= 0 && cc < grid.cols) mask[rr][cc] = 4;
        }
        nodes.push({ c: nc, r: nr });
      }

      // Connect each node to its two nearest neighbours via L-shaped traces.
      for (var i = 0; i < nodes.length; i++) {
        var a = nodes[i];
        var neighbours = nodes
          .map(function (n2, j) { return { j: j, d: Math.abs(a.c - n2.c) + Math.abs(a.r - n2.r) }; })
          .filter(function (x) { return x.j !== i; })
          .sort(function (p, q) { return p.d - q.d; });
        for (var m = 0; m < Math.min(2, neighbours.length); m++) {
          var b = nodes[neighbours[m].j];
          var midC = a.c + Math.round((b.c - a.c) * 0.5);
          var cmin, cmax;
          cmin = Math.min(a.c, midC); cmax = Math.max(a.c, midC);
          for (var cx2 = cmin; cx2 <= cmax; cx2++) if (mask[a.r][cx2] === 0) mask[a.r][cx2] = 2;
          cmin = Math.min(a.r, b.r); cmax = Math.max(a.r, b.r);
          for (var ry = cmin; ry <= cmax; ry++) if (mask[ry][midC] === 0) mask[ry][midC] = 2;
          cmin = Math.min(midC, b.c); cmax = Math.max(midC, b.c);
          for (var cx3 = cmin; cx3 <= cmax; cx3++) if (mask[b.r][cx3] === 0) mask[b.r][cx3] = 2;
        }
      }

      for (var r2 = 0; r2 < grid.rows; r2++) {
        for (var c2 = 0; c2 < grid.cols; c2++) {
          if (mask[r2][c2] !== 0) {
            var delay = 3 * noise[c2] + 0.6 * ((grid.rows - 1 - r2) / grid.rows);
            dots.push(makeDot(c2, r2, mask[r2][c2], delay, grid));
          }
        }
      }

      // Sparse random sparks in empty cells.
      var sparks = Math.round((30 * (grid.cols * grid.rows)) / 1440);
      for (var s = 0; s < sparks; s++) {
        var sc = Math.floor(rng() * grid.cols);
        var sr = Math.floor(rng() * grid.rows);
        if (mask[sr][sc] === 0) dots.push(makeDot(sc, sr, 1, 3 * noise[sc] + 0.6 * rng(), grid));
      }
      return dots;
    },

    /** waveform-b — smoothed multi-frequency wave. */
    'waveform-b': function (grid) {
      var rng = lcgRng(902);
      var noise = prerollNoise(902, grid.cols);
      var heights = [];
      for (var c = 0; c < grid.cols; c++) {
        var t = c / (grid.cols - 1);
        var v = Math.max(0,
          0.7 * Math.sin(t * Math.PI) +
          0.3 * Math.sin(23.7 * t + 1.3) +
          0.15 * Math.sin(47.1 * t + 0.7) +
          (rng() - 0.5) * 0.15);
        heights[c] = Math.floor(2 + v * (0.85 * grid.rows));
      }
      // 1-2-1 smoothing kernel
      for (var c2 = 1; c2 < grid.cols - 1; c2++) {
        heights[c2] = Math.round((heights[c2 - 1] + 2 * heights[c2] + heights[c2 + 1]) / 4);
      }
      var dots = [];
      for (var c3 = 0; c3 < grid.cols; c3++) fillColumn(dots, grid, c3, heights[c3], noise);
      return dots;
    },

    /** waveform-d — saw-tooth-ramp audio. */
    'waveform-d': function (grid) {
      var rng = lcgRng(904);
      var noise = prerollNoise(904, grid.cols);
      var dots = [];
      var segLen = grid.cols / 6;
      for (var c = 0; c < grid.cols; c++) {
        var h = Math.floor(
          2 + ((c % segLen) / segLen) *
            (0.6 * Math.sin((c / (grid.cols - 1)) * Math.PI) + 0.4) *
            (0.8 * grid.rows) + 2 * rng()
        );
        fillColumn(dots, grid, c, h, noise);
      }
      return dots;
    },

    /** waveform-e — double gaussian spikes at 17% and 83%. */
    'waveform-e': function (grid) {
      var rng = lcgRng(905);
      var noise = prerollNoise(905, grid.cols);
      var dots = [];
      for (var c = 0; c < grid.cols; c++) {
        var t = c / (grid.cols - 1);
        var env = Math.max(0,
          Math.exp(-Math.pow(t - 0.17, 2) / 0.012) +
          Math.exp(-Math.pow(t - 0.83, 2) / 0.012) +
          0.15 * Math.sin(t * Math.PI));
        var h = Math.floor(2 + env * (0.85 * grid.rows) + 2 * rng());
        fillColumn(dots, grid, c, h, noise);
      }
      return dots;
    },

    /** waveform-g — a single bell curve centred on the grid. */
    'waveform-g': function (grid) {
      var rng = lcgRng(907);
      var noise = prerollNoise(907, grid.cols);
      var dots = [];
      for (var c = 0; c < grid.cols; c++) {
        var h = Math.floor(
          2 + Math.exp(-Math.pow(c / (grid.cols - 1) - 0.5, 2) / 0.04) *
            (0.9 * grid.rows) + 1.5 * rng()
        );
        fillColumn(dots, grid, c, h, noise);
      }
      return dots;
    },

    /** waveform-h — interference pattern: fast sine × slow envelope. */
    'waveform-h': function (grid) {
      var rng = lcgRng(908);
      var noise = prerollNoise(908, grid.cols);
      var dots = [];
      for (var c = 0; c < grid.cols; c++) {
        var t = c / (grid.cols - 1);
        var h = Math.floor(
          2 + Math.abs(Math.sin(t * Math.PI * 4)) * Math.sin(t * Math.PI) *
            (0.8 * grid.rows) + 2 * rng()
        );
        fillColumn(dots, grid, c, h, noise);
      }
      return dots;
    },

    /** waveform-i — asymmetric double spikes with distance-based delay. */
    'waveform-i': function (grid) {
      var rng = lcgRng(909);
      var dots = [];
      for (var c = 0; c < grid.cols; c++) {
        var t = c / (grid.cols - 1);
        var env = Math.max(0,
          gaussBump(t, 0.17, 0.045, 0.012) +
          gaussBump(t, 0.83, 0.012, 0.045) +
          0.15 * Math.sin(t * Math.PI));
        var h = Math.floor(2 + env * (0.85 * grid.rows) + 2 * rng());
        var delay = 1.8 * Math.min(Math.abs(t - 0.17), Math.abs(t - 0.83)) * 3;
        for (var i = 0; i < Math.min(h, grid.rows); i++) {
          var invR = grid.rows - 1 - i;
          var hh = i / Math.max(h, 1);
          var level = hh < 0.15 ? 4 : hh < 0.4 ? 3 : hh < 0.7 ? 2 : 1;
          dots.push(makeDot(c, invR, level, delay + (i / Math.max(h, 1)) * 0.4, grid));
        }
      }
      return dots;
    },

    /** numeral-1..4 — 5×9 pixel-font digits, each pixel expanded to a 3×2 block. */
    'numeral-1': function (grid) { return numeralGlyph(grid, NUMERAL_GLYPHS[1], 1001); },
    'numeral-2': function (grid) { return numeralGlyph(grid, NUMERAL_GLYPHS[2], 1002); },
    'numeral-3': function (grid) { return numeralGlyph(grid, NUMERAL_GLYPHS[3], 1003); },
    'numeral-4': function (grid) { return numeralGlyph(grid, NUMERAL_GLYPHS[4], 1004); },

    /**
     * text — rasterises an arbitrary string into a dot grid. Reads `data-text`
     * (or `opts.text`). Uses `data-font-family` / `data-font-weight` for the
     * rasterisation font. Wait-for-fonts before calling this variant.
     */
    text: function (grid, inst) {
      var str = (inst && inst.text) || 'HELLO';
      var fontFamily = (inst && inst.fontFamily) || '"VT323", ui-monospace, monospace';
      var fontWeight = (inst && inst.fontWeight) || '700';

      // Rasterise text to an offscreen canvas sized to the grid aspect.
      // Use 10× grid dims as the sample resolution so each cell samples ~1 pixel.
      var sampleW = grid.cols * 10;
      var sampleH = grid.rows * 10;
      var off = document.createElement('canvas');
      off.width  = sampleW;
      off.height = sampleH;
      var octx = off.getContext('2d');
      // Fit text to ~96% of the sample width.
      var testSize = 200;
      octx.font = fontWeight + ' ' + testSize + 'px ' + fontFamily;
      var textW = octx.measureText(str).width || 1;
      var fitSize = Math.floor((sampleW * 0.96 / textW) * testSize);
      // Clamp vertical too — don't exceed ~90% of sample height.
      fitSize = Math.min(fitSize, Math.floor(sampleH * 0.9));
      octx.font = fontWeight + ' ' + fitSize + 'px ' + fontFamily;
      octx.fillStyle = '#fff';
      octx.textAlign    = 'center';
      octx.textBaseline = 'middle';
      octx.fillText(str, sampleW / 2, sampleH / 2);
      var data = octx.getImageData(0, 0, sampleW, sampleH).data;

      var noise = prerollNoise(1337, grid.cols);
      var dots = [];
      for (var r = 0; r < grid.rows; r++) {
        for (var c = 0; c < grid.cols; c++) {
          // Sample the center of each cell.
          var sx = Math.floor(c * 10 + 5);
          var sy = Math.floor(r * 10 + 5);
          var alpha = data[(sy * sampleW + sx) * 4 + 3];
          if (alpha <= 128) continue;
          // Vary level slightly based on alpha + noise for organic feel.
          var base = alpha > 220 ? 4 : alpha > 180 ? 3 : alpha > 140 ? 2 : 1;
          var delay = 3 * noise[c] + (r / grid.rows) * 0.6;
          dots.push(makeDot(c, r, base, delay, grid));
        }
      }
      return dots;
    }
  };

  /** 5×9 pixel-font bitmaps for digits 1-4 (copied from buildanything's renderer). */
  var NUMERAL_GLYPHS = {
    1: ['..X..', '.XX..', '..X..', '..X..', '..X..', '..X..', '..X..', '..X..', '.XXX.'],
    2: ['.XXX.', 'X...X', '....X', '...X.', '..X..', '.X...', 'X....', 'X...X', '.XXX.'],
    3: ['.XXX.', 'X...X', '....X', '....X', '.XXX.', '....X', '....X', 'X...X', '.XXX.'],
    4: ['...X.', '..XX.', '.X.X.', 'X..X.', 'XXXXX', '...X.', '...X.', '...X.', '...X.']
  };

  /** Tile a 5×9 glyph as a 3×2 pixel-block expansion centred in the grid. */
  function numeralGlyph(grid, glyph, seed) {
    var rng = lcgRng(seed);
    var dots = [];
    // Glyph footprint: 5 cols × 9 rows expanded to 15 × 18 cells.
    var startCol = Math.floor((grid.cols - 15) / 2);
    var startRow = Math.floor((grid.rows - 18) / 2);
    var centerC = startCol + 7.5;
    var centerR = startRow + 9;
    var diag = Math.sqrt(7.5 * 7.5 + 9 * 9);
    for (var gy = 0; gy < 9; gy++) {
      for (var gx = 0; gx < 5; gx++) {
        if (glyph[gy][gx] !== 'X') continue;
        for (var by = 0; by < 2; by++) {
          for (var bx = 0; bx < 3; bx++) {
            var col = startCol + 3 * gx + bx;
            var row = startRow + 2 * gy + by;
            if (col < 0 || col >= grid.cols || row < 0 || row >= grid.rows) continue;
            var lvl = 2;
            var p = rng();
            if (p < 0.3) lvl = Math.min(4, lvl + 1);
            else if (p > 0.7) lvl = Math.max(1, lvl - 1);
            var dx = col - centerC, dy = row - centerR;
            var delay = (Math.sqrt(dx * dx + dy * dy) / diag) * 5.4 + 0.8 * rng();
            var dot = makeDot(col, row, lvl, delay, grid);
            dot.lift = 2;
            dots.push(dot);
          }
        }
      }
    }
    return dots;
  }

  /** Fill a single column from the bottom up to `h` rows, used by waveform variants. */
  function fillColumn(dots, grid, col, h, noise) {
    var cap = Math.min(h, grid.rows);
    for (var i = 0; i < cap; i++) {
      var invR = grid.rows - 1 - i;
      var hh = i / Math.max(h, 1);
      var level = hh < 0.15 ? 4 : hh < 0.4 ? 3 : hh < 0.7 ? 2 : 1;
      var delay = 3 * noise[col] + (i / Math.max(h, 1)) * 0.6;
      dots.push(makeDot(col, invR, level, delay, grid));
    }
  }

  /** 3-octave fractal value noise on a 2D domain. */
  function fractalNoise(x, y, octaves) {
    var total = 0, amp = 1, freq = 1, norm = 0;
    for (var i = 0; i < octaves; i++) {
      total += valueNoise(x * freq, y * freq, 42 + 100 * i) * amp;
      norm += amp;
      amp *= 0.5;
      freq *= 2;
    }
    return total / norm;
  }

  /** Single-octave smoothed value noise. */
  function valueNoise(x, y, seed) {
    function hash(a, b) {
      var o = (0x165667b1 * a + 0x27d4eb2f * b + 0x4bf19f61 * seed) | 0;
      var l = (o ^ (o >> 13)) * 0x4bf19f61;
      return ((l ^ (l >> 16)) & 0x7fffffff) / 0x7fffffff;
    }
    var xi = Math.floor(x), yi = Math.floor(y);
    var xf = x - xi, yf = y - yi;
    var u = xf * xf * (3 - 2 * xf);
    var v = yf * yf * (3 - 2 * yf);
    var a = hash(xi, yi),     b = hash(xi + 1, yi);
    var c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
    return (a + u * (b - a)) + v * ((c + u * (d - c)) - (a + u * (b - a)));
  }

  // ---- PatternInstance ------------------------------------------------------
  function PatternInstance(el, opts) {
    Instance.call(this, el, opts);
    this.variant = attr(el, 'variant', opts, 'bricks');
    this.gridName = attr(el, 'grid', opts, 'graphic');

    // Explicit dims override preset.
    var explicitCols = parseInt(attr(el, 'cols', opts, 0), 10);
    var explicitRows = parseInt(attr(el, 'rows', opts, 0), 10);
    var preset = patternGrids[this.gridName] || patternGrids.graphic;
    this.grid = {
      cols: explicitCols || preset.cols,
      rows: explicitRows || preset.rows,
      padX: preset.padX,
      padY: preset.padY
    };

    this.cellScale = parseFloat(attr(el, 'cell-size', opts, 1));

    // text-variant specific config
    this.text = attr(el, 'text', opts, '');
    this.fontFamily = attr(el, 'font-family', opts, '"VT323", ui-monospace, monospace');
    this.fontWeight = attr(el, 'font-weight', opts, '700');

    this.reducedMotion = false;
    this._startTime = 0;
    this._setup();
  }
  PatternInstance.prototype = Object.create(Instance.prototype);
  PatternInstance.prototype.constructor = PatternInstance;

  PatternInstance.prototype._setup = function () {
    var self = this;
    this._createCanvas();
    this._watchResize();
    this._generateDots();
    this.resize();

    // Respect prefers-reduced-motion.
    var mql = window.matchMedia('(prefers-reduced-motion: reduce)');
    this.reducedMotion = mql.matches;
    mql.addEventListener('change', function (e) {
      self.reducedMotion = e.matches;
      self._drawFrame(performance.now());
    });

    // Pause render loop when offscreen.
    observeVisibility(this.el, function (visible) {
      self.inView = visible;
      if (visible) self._startLoop();
    });
  };

  PatternInstance.prototype._generateDots = function () {
    var fn = patternVariants[this.variant];
    this.dots = fn ? fn(this.grid, this) : [];
  };

  PatternInstance.prototype._startLoop = function () {
    if (this.paused || this.reducedMotion) {
      this._drawFrame(performance.now());
      return;
    }
    var self = this;
    function loop(t) {
      if (self.destroyed) return;
      if (!self.inView || self.paused) return;
      self._drawFrame(t);
      requestAnimationFrame(loop);
    }
    requestAnimationFrame(loop);
  };

  PatternInstance.prototype._drawFrame = function (tMs) {
    var ctx = this.ctx;
    if (!ctx) return;
    var dpr = this.dpr;
    var w   = this.canvas.width / dpr;
    var h   = this.canvas.height / dpr;
    ctx.clearRect(0, 0, w, h);

    // Fit the grid into the canvas, scaled uniformly.
    var gridW = this.grid.cols * 10 + this.grid.padX * 2;
    var gridH = this.grid.rows * 10 + this.grid.padY * 2;
    var scale = Math.min(w / gridW, h / gridH);
    var offsetX = (w - gridW * scale) / 2;
    var offsetY = (h - gridH * scale) / 2;
    var dotR = 4 * scale;
    var tSec = (tMs - this._startTime) / 1000;

    ctx.fillStyle = this.activeColor;
    for (var i = 0; i < this.dots.length; i++) {
      var d = this.dots[i];
      var o = this.reducedMotion ? d.opacity : pulseOpacity(d, tSec);
      if (o < 0.01) continue;
      var lift = this.reducedMotion ? 0 : pulseLift(d, tSec) * scale;
      ctx.globalAlpha = o;
      drawDot(ctx, offsetX + d.x * scale, offsetY + (d.y) * scale - lift, dotR * this.cellScale, this.dotShape);
    }
    ctx.globalAlpha = 1;
  };

  PatternInstance.prototype.resize = function () {
    var rect = this.el.getBoundingClientRect();
    this._sizeCanvas(rect.width || 200, rect.height || 120);
    this._startTime = performance.now();
    this._drawFrame(this._startTime);
  };

  PatternInstance.prototype.play = function () {
    Instance.prototype.play.call(this);
    this._startLoop();
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
      case 'pattern':
        inst = new PatternInstance(el, opts);
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
    instances: instances,

    /**
     * Algorithmic pattern mode — plug in custom variants, reach the grid presets.
     *
     *   DotMatrix.patterns.register("myShape", function (grid) { return [...dots] });
     *   DotMatrix.patterns.grids.graphic.cols  // 48
     */
    patterns: {
      variants: patternVariants,
      grids:    patternGrids,
      /** Register a new variant function. Returns DotMatrix for chaining. */
      register: function (name, fn) { patternVariants[name] = fn; return DotMatrix; }
    }
  };

  // Auto-init on DOMContentLoaded (browser only — SSR-safe guard)
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () { DotMatrix.init(); });
    } else {
      // DOM already loaded — defer slightly to let fonts load
      DotMatrix.init();
    }
  }

  return DotMatrix;
}));
