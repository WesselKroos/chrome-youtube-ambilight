import { $, html, body, waitForDomElement, on, off, raf, ctxOptions, Canvas, SafeOffscreenCanvas, requestIdleCallback, setTimeout, wrapErrorHandler } from './libs/generic'
import AmbilightSentry, { getPlayerContainersNodeTree, getVideosNodeTree } from './libs/ambilight-sentry'
import { HorizontalBarDetection } from './horizontal-bar-detection'

class Ambilight {
  static isClassic = false
  VIEW_DETACHED = 'VIEW_DETACHED'
  VIEW_SMALL = 'VIEW_SMALL'
  VIEW_THEATER = 'VIEW_THEATER'
  VIEW_FULLSCREEN = 'VIEW_FULLSCREEN'
  VIEW_POPUP = 'VIEW_POPUP'

  horizontalBarsClipPX = 0
  lastCheckVideoSizeTime = 0

  videoProjectorOffset = {}
  srcVideoOffset = {}

  isHidden = true
  isOnVideoPage = true
  showedCompareWarning = false
  getImageDataAllowed = true

  atTop = true
  p = null
  view = -1
  isFullscreen = false
  isFillingFullscreen = false
  isVR = false

  lastUpdateStatsTime = 0
  videoFrameCount = 0
  displayFrameRate = 0
  videoFrameRate = 0
  videoFrameRateMeasureStartTime = 0
  videoFrameRateMeasureStartFrame = 0
  ambilightFrameCount = 0
  ambilightFrameRate = 0
  ambilightVideoDroppedFrameCount = 0
  previousFrameTime = 0
  previousDrawTime = 0
  frameDuration = 1
  syncInfo = []

  enableMozillaBug1606251Workaround = false
  enableChromiumBug1092080Workaround = false

  constructor(ytdAppElem, videoElem) {
    this.ytdAppElem = ytdAppElem
    const mastheadSelector = Ambilight.isClassic ? '#yt-masthead-container' : '#masthead-container'
    this.mastheadElem = ytdAppElem.querySelector(mastheadSelector)
    if(!this.mastheadElem) {
      throw new Error(`Cannot find mastheadElem: ${mastheadSelector}`)
    }

    this.videoHasRequestVideoFrameCallback = !!videoElem.requestVideoFrameCallback
    this.detectChromiumBug1142112Workaround()
    this.initElems(videoElem)
    this.initVideoElem(videoElem)
    this.detectMozillaBug1606251Workaround()
    this.detectChromiumBug1092080Workaround()

    this.initFeedbackLink()
    this.initSettings()

    this.initAmbilightElems()
    this.initBuffers()
    this.initFPSListElem()

    this.initStyles()
    this.updateStyles()

    this.updateImmersiveMode()
    this.checkGetImageDataAllowed()

    this.initListeners()

    if (this.enabled)
      this.enable(true)
  }

  initElems(videoElem) {
    if(!Ambilight.isClassic) {
      this.ytdWatchFlexyElem = videoElem.closest('ytd-watch-flexy')
      if(!this.ytdWatchFlexyElem) {
        throw new Error('Cannot find ytdWatchFlexyElem: ytd-watch-flexy')
      }
    } else {
      this.pageElem = $.s('#page')
      if(!this.pageElem) {
        throw new Error('Cannot find pageElem: #page')
      }
    }

    this.videoPlayerElem = videoElem.closest('.html5-video-player')
    if(!this.videoPlayerElem) {
      throw new Error('Cannot find videoPlayerElem: .html5-video-player')
    }

    this.videoContainerElem = videoElem.closest('.html5-video-container')
    if (!this.videoContainerElem) {
      throw new Error('Cannot find videoContainerElem: .html5-video-container')
    }
    
    this.settingsMenuBtnParent = this.videoPlayerElem.querySelector('.ytp-right-controls, .ytp-chrome-controls > *:last-child')
    if(!this.settingsMenuBtnParent) {
      throw new Error('Cannot find settingsMenuBtnParent: .ytp-right-controls, .ytp-chrome-controls > *:last-child')
    }
  }

  handleVideoResize = (checkPosition = true) => {
    // Make sure to trigger checkVideoSize to call updateSizes. So that
    // this.view is updated before this.updateImmersiveMode is called
    this.sizesInvalidated = true
    this.updateImmersiveMode()
    this.checkVideoSize(checkPosition)
    this.nextFrame()
  }

  initVideoElem(videoElem) {
    this.videoElem = videoElem
    this.applyChromiumBug1142112Workaround()
  }

  // FireFox workaround: Force to rerender the outer blur of the canvasses
  // https://bugzilla.mozilla.org/show_bug.cgi?id=1606251
  detectMozillaBug1606251Workaround() {
    const match = navigator.userAgent.match(/Firefox\/((?:\.|[0-9])+)/)
    const version = (match && match.length > 1) ? parseFloat(match[1]) : null
    if(version && version < 74) {
      this.enableMozillaBug1606251Workaround = resetThemeToLightIfSettingIsTrue
    }
  }

  // Chromium workaround: YouTube drops the video quality because the video is dropping frames 
  // when requestVideoFrameCallback is used and the video is offscreen 
  // https://bugs.chromium.org/p/chromium/issues/detail?id=1142112
  detectChromiumBug1142112Workaround() {
    const match = navigator.userAgent.match(/Chrome\/((?:\.|[0-9])+)/)
    const version = (match && match.length > 1) ? parseFloat(match[1]) : null
    if(version && this.videoHasRequestVideoFrameCallback) {
      this.enableChromiumBug1142112Workaround = true
    }
  }

  applyChromiumBug1142112Workaround() {
    if(!this.enableChromiumBug1142112Workaround) return;

    try {
      if(this.videoObserver) {
        this.videoObserver.disconnect()
      }

      this.videoIsHidden = false
      if(!this.videoObserver) {
        this.videoObserver = new IntersectionObserver(
          (entries, observer) => {
            // Disconnect when ambilight crashed on initialization to avoid invalid error reports
            if(!window.ambilight) {
              observer.disconnect()
              return
            }

            entries.forEach(entry => {
              this.videoIsHidden = (entry.intersectionRatio === 0)
              this.videoVisibilityChangeTime = performance.now()
              this.videoElem.getVideoPlaybackQuality() // Correct dropped frames
            })
          },
          {
            threshold: 0.0001 // Because sometimes a pixel in not visible on screen but the intersectionRatio is already 0
          }
        )
      }

      const videoElem = this.videoElem
      this.videoObserver.observe(videoElem)
      
      if(videoElem.ambilightGetVideoPlaybackQuality) return

      const ambilight = this
      Object.defineProperty(videoElem, 'ambilightGetVideoPlaybackQuality', {
        value: videoElem.getVideoPlaybackQuality
      })
      this.previousDroppedVideoFrames = 0
      this.droppedVideoFramesCorrection = 0
      let previousGetVideoPlaybackQualityTime = performance.now()
      videoElem.getVideoPlaybackQuality = function() {
        const original = videoElem.ambilightGetVideoPlaybackQuality()
        let droppedVideoFrames = original.droppedVideoFrames
        if(droppedVideoFrames < ambilight.previousDroppedVideoFrames) {
          ambilight.previousDroppedVideoFrames = 0
          ambilight.droppedVideoFramesCorrection = 0
        }
        // Ignore dropped frames for 2 seconds due to requestVideoFrameCallback dropping frames when the video is offscreen
        if(ambilight.videoIsHidden || (ambilight.videoVisibilityChangeTime > previousGetVideoPlaybackQualityTime - 2000)) {
          ambilight.droppedVideoFramesCorrection += (droppedVideoFrames - ambilight.previousDroppedVideoFrames)
          // console.log('droppedVideoFramesCorrection ', ambilight.droppedVideoFramesCorrection)
        } else {
          // console.log('Reporting original', original.droppedVideoFrames, ' dropped frames')
        }
        ambilight.previousDroppedVideoFrames = droppedVideoFrames
        droppedVideoFrames = Math.max(0, droppedVideoFrames - ambilight.droppedVideoFramesCorrection)
        // if(ambilight.droppedVideoFramesCorrection) {
        //   console.log('original droppedVideoFrames:', ambilight.previousDroppedVideoFrames, ' corrected:', droppedVideoFrames)
        // }
        previousGetVideoPlaybackQualityTime = performance.now()
        return {
          corruptedVideoFrames: original.corruptedVideoFrames,
          creationTime: original.creationTime,
          droppedVideoFrames,
          totalVideoFrames: original.totalVideoFrames,
        }
      }
    } catch(ex) {
      console.warn('YouTube Ambilight | applyChromiumBug1142112Workaround error. Continuing ambilight initialization...')
      AmbilightSentry.captureExceptionWithDetails(ex)
    }
  }

  // Chromium workaround: drawImage randomly disables antialiasing in the videoOverlay and/or projectors
  // Additional 0.05ms performance impact per clearRect()
  // https://bugs.chromium.org/p/chromium/issues/detail?id=1092080
  detectChromiumBug1092080Workaround() {
    const match = navigator.userAgent.match(/Chrome\/((?:\.|[0-9])+)/)
    const version = (match && match.length > 1) ? parseFloat(match[1]) : null
    if(version && version >= 82 && version < 88) {
      this.enableChromiumBug1092080Workaround = true
    }
  }

  initStyles () {
    this.styleElem = document.createElement('style')
    this.styleElem.appendChild(document.createTextNode(''))
    document.head.appendChild(this.styleElem)
  }

  lastVideoElemSrc = ''
  initVideoIfSrcChanged() {
    if(this.lastVideoElemSrc === this.videoElem.src) {
      return false
    }

    this.lastVideoElemSrc = this.videoElem.src
    this.start()

    return true
  }

  initListeners() {
    ////// PLAYER FLOW
    //
    // LEGEND
    //
    // [  Start
    // ]  End
    // *  When drawImage is called
    //
    // FLOWS
    //
    // Start (paused):                                                                      [ *loadeddata -> canplay ]
    // Start (playing):                            [ play    ->                               *loadeddata -> canplay -> *playing ]
    // Start (from previous video):  [ emptied 2x -> play    ->                               *loadeddata -> canplay -> *playing ]
    // Video src change (paused):    [    emptied ->                               *seeked ->  loadeddata -> canplay ]
    // Video src change (playing):   [    emptied -> play                                     *loadeddata -> canplay -> *playing ]
    // Quality change (paused):      [    emptied ->            seeking ->         *seeked ->  loadeddata -> canplay ]
    // Quality change (playing):     [    emptied -> play    -> seeking ->         *seeked ->  loadeddata -> canplay -> *playing ]
    // Seek (paused):                                         [ seeking ->         *seeked ->                canplay ]
    // Seek (playing):                             [ pause   -> seeking -> play -> *seeked ->                canplay -> *playing ]
    // Play:                                                             [ play ->                                      *playing ]
    // Load more data (playing):                   [ waiting ->                                              canplay -> *playing ]
    // End video:  [ pause -> ended ]
    //
    //////

    on(this.videoElem, 'seeked', () => {
      // When the video is paused this is the first event. Else [loadeddata] is first
      if (this.initVideoIfSrcChanged()) return

      this.buffersCleared = true // Always prevent old frame from being drawn
      this.nextFrame()
    })
    on(this.videoElem, 'loadeddata', (e) => {
      // Whent the video is playing this is the first event. Else [seeked] is first
      this.initVideoIfSrcChanged()
    })
    on(this.videoElem, 'playing', () => {
      if (this.videoElem.paused) return // When paused handled by [seeked]
      this.scheduleNextFrame()
    })
    on(this.videoElem, 'ended', () => {
      this.clear()
      this.scheduledNextFrame = false
      this.resetVideoContainerStyle() // Prevent visible video element above player because of the modified style attribute
    })
    on(this.videoElem, 'emptied', () => {
      this.clear()
      this.scheduledNextFrame = false
    })
    on(this.videoElem, 'error', (ex) => {
      console.error('Video error:', ex)
    })

    on(document, 'visibilitychange', () => {
      if (!this.enabled || !this.isOnVideoPage) return
      if(document.visibilityState !== 'hidden') return

      this.buffersCleared = true
      this.checkIfNeedToHideVideoOverlay()
    }, false);

    on(document, 'keydown', (e) => {
      if (!this.isOnVideoPage) return
      if (document.activeElement) {
        const el = document.activeElement
        const tag = el.tagName
        const inputs = ['INPUT', 'SELECT', 'TEXTAREA']
        if (
          inputs.indexOf(tag) !== -1 || 
          (
            el.getAttribute('contenteditable') !== null && 
            el.getAttribute('contenteditable') !== 'false'
          )
        ) {
          return
        }
      }
      if (e.keyCode === 90) // z
        this.toggleImmersiveMode()
      else if (e.keyCode === 65) // a
        this.toggleEnabled()
      else if (e.keyCode === 66) // b
        $.s(`#setting-detectHorizontalBarSizeEnabled`).click()
      else if (e.keyCode === 87) // w
        $.s(`#setting-detectVideoFillScaleEnabled`).click()
    })

    this.bodyResizeObserver = new ResizeObserver(wrapErrorHandler(entries => {
      if (!this.enabled || !this.isOnVideoPage) return
      this.handleVideoResize()
    }))
    this.bodyResizeObserver.observe(document.body)

    this.videoResizeObserver = new ResizeObserver(wrapErrorHandler(entries => {
      if (!this.enabled) return
      this.handleVideoResize(false)
    }))
    this.videoResizeObserver.observe(this.videoElem)


    // Fix YouTube bug: focus on video element without scrolling to the top
    on(this.videoElem, 'focus', () => {
      if(this.videoElem.getBoundingClientRect().top !== 0) return
      
      window.scrollTo(window.scrollX, 0)
    }, true)


    // More reliable way to detect the end screen and other modes in which the video is invisible.
    // Because when seeking to the end the ended event is not fired from the videoElem
    if (this.videoPlayerElem) {
      on(this.videoPlayerElem, 'onStateChange', (state) => {
        this.isBuffering = (state === 3)

        if(!this.isBuffering)
          this.scheduleNextFrame()
      })
      this.isBuffering = (this.videoPlayerElem.getPlayerState() === 3)

      const observer = new MutationObserver(wrapErrorHandler((mutationsList, observer) => {
        const mutation = mutationsList[0]
        const classList = mutation.target.classList
        
        const isVideoHiddenOnWatchPage = (
          classList.contains('ended-mode') || 
          // classList.contains('unstarted-mode')  || // Unstarted is not hidden? Causes initial render without ambilight
          classList.contains('ytp-player-minimized')
        )
        if(this.isVideoHiddenOnWatchPage === isVideoHiddenOnWatchPage) return

        this.isVideoHiddenOnWatchPage = isVideoHiddenOnWatchPage
        if(!this.isVideoHiddenOnWatchPage) {
          this.optionalFrame()
          return
        }

        this.clear()
        this.resetVideoContainerStyle()
      }))
    
      observer.observe(this.videoPlayerElem, {
        attributes: true,
        attributeOldValue: true,
        attributeFilter: ['class']
      })
    } else {
      console.warn('YouTube Ambilight | html5-video-player not found')
    }
  }

  checkGetImageDataAllowed(reportUnexpectedChange = false) {
    const isSameOriginVideo = (this.videoElem.src && this.videoElem.src.indexOf(location.origin) !== -1)
    const getImageDataAllowed = (!window.chrome || isSameOriginVideo)
    if(this.getImageDataAllowed === getImageDataAllowed) return

    this.getImageDataAllowed = getImageDataAllowed

    const settings = [
      $.s(`#setting-detectHorizontalBarSizeEnabled`),
      $.s(`#setting-detectColoredHorizontalBarSizeEnabled`),
      $.s(`#setting-detectHorizontalBarSizeOffsetPercentage`)
    ].filter(setting => setting)
    if(this.getImageDataAllowed) {
      settings.forEach(setting => setting.style.display = '')
    } else {
      settings.forEach(setting => setting.style.display = 'none')
    }
  }

  initAmbilightElems() {
    this.elem = document.createElement('div')
    this.elem.classList.add('ambilight')
    body.prepend(this.elem)

    this.topElem = document.createElement('div')
    this.topElem.classList.add('ambilight__top')
    this.elem.prepend(this.topElem)
    
    this.topElemObserver = new IntersectionObserver(
      (entries, observer) => {
        entries.forEach(entry => {
          this.atTop = (entry.intersectionRatio !== 0)
          this.checkScrollPosition()
        })
      },
      {
        threshold: 0.0001 // Because sometimes a pixel in not visible on screen but the intersectionRatio is already 0
      }
    )
    this.topElemObserver.observe(this.topElem)

    this.videoShadowElem = document.createElement('div')
    this.videoShadowElem.classList.add('ambilight__video-shadow')
    this.elem.prepend(this.videoShadowElem)

    this.filterElem = document.createElement('div')
    this.filterElem.classList.add('ambilight__filter')
    this.elem.prepend(this.filterElem)

    this.projectorsElem = document.createElement('div')
    this.projectorsElem.classList.add('ambilight__projectors')
    this.filterElem.prepend(this.projectorsElem)

    const projectorElem = new Canvas(1, 1)
    projectorElem.classList.add('ambilight__projector')
    this.projectorsElem.prepend(projectorElem)
    this.projector = {
      elem: projectorElem,
      ctx: projectorElem.getContext('2d', { ...ctxOptions, alpha: true })
    }

    const shadowElem = new Canvas(1, 1)
    shadowElem.classList.add('ambilight__shadow')
    this.projectorsElem.appendChild(shadowElem)
    const shadowCtx = shadowElem.getContext('2d', { ...ctxOptions, alpha: true })
    this.shadow = {
      elem: shadowElem,
      ctx: shadowCtx
    }

    // Dont draw ambilight when its not in viewport
    this.isAmbilightHiddenOnWatchPage = false
    if(this.shadowObserver) {
      this.shadowObserver.disconnect()
    }
    if(!this.shadowObserver) {
      this.shadowObserver = new IntersectionObserver(
        (entries, observer) => {
          entries.forEach(entry => {
            this.isAmbilightHiddenOnWatchPage = (entry.intersectionRatio === 0)
            if(!this.isAmbilightHiddenOnWatchPage) {
              this.optionalFrame()
            }
          })
        },
        {
          threshold: 0.0001 // Because sometimes a pixel in not visible on screen but the intersectionRatio is already 0
        }
      )
    }
    this.shadowObserver.observe(shadowElem)

    // Warning: Using Canvas elements in this div instead of OffScreenCanvas
    // while waiting for a fix for this issue:
    // https://bugs.chromium.org/p/chromium/issues/detail?id=1015729
    //this.buffersElem = document.createElement('div')
    //this.buffersElem.classList.add('ambilight__buffers')
    //this.elem.prepend(this.buffersElem)
  }

  initBuffers() {
    this.buffersWrapperElem = document.createElement('div')
    this.buffersWrapperElem.classList.add('ambilight__buffers-wrapper')

    const videoSnapshotBufferElem = new Canvas(1, 1, true)
    if (videoSnapshotBufferElem.tagName === 'CANVAS') {
      this.buffersWrapperElem.appendChild(videoSnapshotBufferElem)
    }
    this.videoSnapshotBuffer = {
      elem: videoSnapshotBufferElem,
      ctx: videoSnapshotBufferElem.getContext('2d', ctxOptions)
    }

    const videoSnapshotGetImageDataBufferElem = new SafeOffscreenCanvas(1, 1)
    if (videoSnapshotGetImageDataBufferElem.tagName === 'CANVAS') {
      this.buffersWrapperElem.appendChild(videoSnapshotGetImageDataBufferElem)
    }
    this.videoSnapshotGetImageDataBuffer = {
      elem: videoSnapshotGetImageDataBufferElem,
      ctx: videoSnapshotGetImageDataBufferElem.getContext('2d', {
        ...ctxOptions,
        desynchronized: true
      })
    }

    const blurBufferElem = new Canvas(1, 1, true)
    if (blurBufferElem.tagName === 'CANVAS') {
      this.buffersWrapperElem.appendChild(blurBufferElem)
    }
    this.blurBuffer = {
      elem: blurBufferElem,
      ctx: blurBufferElem.getContext('2d', { ...ctxOptions, alpha: true })
    }
    

    const projectorBlurBufferElem = new Canvas(1, 1, true)
    if (projectorBlurBufferElem.tagName === 'CANVAS') {
      this.buffersWrapperElem.appendChild(projectorBlurBufferElem)
    }
    this.projectorBlurBuffer = {
      elem: projectorBlurBufferElem,
      ctx: projectorBlurBufferElem.getContext('2d', { ...ctxOptions, alpha: true })
    }

    const projectorsBufferElem = new Canvas(1, 1, true)
    if (projectorsBufferElem.tagName === 'CANVAS') {
      this.buffersWrapperElem.appendChild(projectorsBufferElem)
    }
    this.projectorBuffer = {
      elem: projectorsBufferElem,
      ctx: projectorsBufferElem.getContext('2d', { ...ctxOptions, alpha: true })
    }

    const cornerShadowBufferElem = new Canvas(1, 1, true)
    if (cornerShadowBufferElem.tagName === 'CANVAS') {
      this.buffersWrapperElem.appendChild(cornerShadowBufferElem)
    }
    this.cornerShadowBuffer = {
      elem: cornerShadowBufferElem,
      ctx: cornerShadowBufferElem.getContext('2d', { ...ctxOptions, alpha: true })
    }

    const sideShadowBufferElem = new Canvas(1, 1, true)
    if (sideShadowBufferElem.tagName === 'CANVAS') {
      this.buffersWrapperElem.appendChild(sideShadowBufferElem)
    }
    this.sideShadowBuffer = {
      elem: sideShadowBufferElem,
      ctx: sideShadowBufferElem.getContext('2d', { ...ctxOptions, alpha: true })
    }

    const shadowBufferElem = new Canvas(1, 1, true)
    if (shadowBufferElem.tagName === 'CANVAS') {
      this.buffersWrapperElem.appendChild(shadowBufferElem)
    }
    this.shadowBuffer = {
      elem: shadowBufferElem,
      ctx: shadowBufferElem.getContext('2d', { ...ctxOptions, alpha: true })
    }

    const shadowPreBlurBufferElem = new Canvas(1, 1, true)
    if (shadowPreBlurBufferElem.tagName === 'CANVAS') {
      this.buffersWrapperElem.appendChild(shadowPreBlurBufferElem)
    }
    this.shadowPreBlurBuffer = {
      elem: shadowPreBlurBufferElem,
      ctx: shadowPreBlurBufferElem.getContext('2d', { ...ctxOptions, alpha: true })
    }

    const shadowBlurBufferElem = new Canvas(1, 1, true)
    if (shadowBlurBufferElem.tagName === 'CANVAS') {
      this.buffersWrapperElem.appendChild(shadowBlurBufferElem)
    }
    this.shadowBlurBuffer = {
      elem: shadowBlurBufferElem,
      ctx: shadowBlurBufferElem.getContext('2d', { ...ctxOptions, alpha: true })
    }

    this.elem.appendChild(this.buffersWrapperElem)
  }

  initSettings() {
    this.settings = [
      {
        type: 'section',
        label: 'Settings',
        name: 'sectionSettingsCollapsed',
        default: true
      },
      {
        name: 'advancedSettings',
        label: 'Advanced',
        type: 'checkbox',
        default: false
      },
      {
        type: 'section',
        label: 'Quality',
        name: 'sectionAmbilightQualityPerformanceCollapsed',
        default: true,
        advanced: false
      },
      {
        name: 'showFPS',
        label: 'Show framerate',
        type: 'checkbox',
        default: false,
        advanced: true
      },
      {
        name: 'frameSync',
        label: '<span style="display: inline-block; padding: 5px 0">Synchronization <a title="How much energy will be spent on sychronising the ambilight effect with the video.\n\nPower Saver: Lowest CPU & GPU usage.\nMight result in ambilight with dropped and delayed frames.\n\nBalanced: Medium CPU & GPU usage.\nMight still result in ambilight with delayed frames on higher than 1080p videos.\n\nHigh Performance: Highest CPU & GPU usage.\nMight still result in delayed frames on high refreshrate monitors (120hz and higher) and higher than 1080p videos.\n\nPerfect (Experimental): Lowest CPU & GPU usage.\nIt is perfect, but in an experimental fase because it\'s based on a new browser technique." href="#" onclick="return false" style="padding: 0 5px;">?</a>',
        type: 'list',
        default: 50,
        min: 0,
        max: 100,
        step: 50,
        advanced: false
      },
      {
        name: 'framerateLimit',
        label: 'Limit framerate (per second)',
        type: 'list',
        default: 0,
        min: 0,
        max: 60,
        step: 1,
        advanced: true
      },
      {
        experimental: true,
        name: 'videoOverlayEnabled',
        label: '<span style="display: inline-block; padding: 5px 0">Sync video with ambilight <a title="Delays the video frames according to the ambilight frametimes. This makes sure that that the ambilight is never out of sync with the video, but it can introduce stuttering and/or dropped frames." href="#" onclick="return false" style="padding: 0 5px;">?</a></span>',
        type: 'checkbox',
        default: false,
        advanced: true
      },
      {
        experimental: true,
        name: 'videoOverlaySyncThreshold',
        label: '<span style="display: inline-block; padding: 5px 0">Sync video disable threshold<br/><span class="ytpa-menuitem-description">(Disable when dropping % of frames)</span></span>',
        type: 'list',
        default: 5,
        min: 1,
        max: 100,
        step: 1,
        advanced: true
      },
      {
        experimental: true,
        name: 'frameBlending',
        label: '<span style="display: inline-block; padding: 5px 0">Smooth motion (frame blending) <a title="Click for more information about Frame blending" href="https://nl.linkedin.com/learning/premiere-pro-guru-speed-changes/frame-sampling-vs-frame-blending" target="_blank" style="padding: 0 5px;">?</a><br/><span class="ytpa-menuitem-description">(More GPU usage. Works with "Sync video")</span></span>',
        type: 'checkbox',
        default: false,
        advanced: true
      },
      {
        experimental: true,
        name: 'frameBlendingSmoothness',
        label: 'Smooth motion strength',
        type: 'list',
        default: 80,
        min: 0,
        max: 100,
        step: 1,
        advanced: true
      },
      {
        type: 'section',
        label: 'Page content',
        name: 'sectionOtherPageContentCollapsed',
        default: false
      },
      {
        name: 'surroundingContentTextAndBtnOnly',
        label: 'Shadow only on text and buttons<br/><span class="ytpa-menuitem-description">(Decreases scroll & video stutter)</span>',
        type: 'checkbox',
        advanced: true,
        default: true
      },
      {
        name: 'surroundingContentShadowSize',
        label: 'Shadow size',
        type: 'list',
        default: 15,
        min: 0,
        max: 100,
        step: .1
      },
      {
        name: 'surroundingContentShadowOpacity',
        label: 'Shadow opacity',
        type: 'list',
        default: 30,
        min: 0,
        max: 100,
        step: .1
      },
      {
        name: 'surroundingContentImagesTransparency',
        label: 'Images transparency',
        type: 'list',
        default: 0,
        min: 0,
        max: 100,
        step: 1,
        advanced: true
      },
      {
        name: 'immersive',
        label: 'Hide when scrolled to top [Z]',
        type: 'checkbox',
        default: false
      },
      {
        name: 'immersiveTheaterView',
        label: 'Hide in theater mode',
        type: 'checkbox',
        default: false
      },
      {
        name: 'hideScrollbar',
        label: 'Hide scrollbar',
        type: 'checkbox',
        default: false
      },
      {
        type: 'section',
        label: 'Video',
        name: 'sectionVideoResizingCollapsed',
        default: true
      },
      {
        name: 'videoScale',
        label: 'Size',
        type: 'list',
        default: 100,
        min: 25,
        max: 200,
        step: 0.1
      },
      {
        name: 'videoShadowSize',
        label: 'Shadow size',
        type: 'list',
        default: 0,
        min: 0,
        max: 100,
        step: .1
      },
      {
        name: 'videoShadowOpacity',
        label: 'Shadow opacity',
        type: 'list',
        default: 50,
        min: 0,
        max: 100,
        step: .1
      },
      {
        type: 'section',
        label: 'Black bars',
        name: 'sectionHorizontalBarsCollapsed',
        default: true
      },
      {
        name: 'detectHorizontalBarSizeEnabled',
        label: 'Remove black bars [B]<br/><span class="ytpa-menuitem-description">(More CPU usage)</span>',
        type: 'checkbox',
        default: false
      },
      {
        name: 'detectColoredHorizontalBarSizeEnabled',
        label: 'Also remove colored bars',
        type: 'checkbox',
        default: false
      },
      {
        name: 'detectHorizontalBarSizeOffsetPercentage',
        label: 'Black bar detection offset',
        type: 'list',
        default: 0,
        min: -5,
        max: 5,
        step: 0.1,
        advanced: true
      },
      {
        name: 'horizontalBarsClipPercentage',
        label: 'Black bars size',
        type: 'list',
        default: 0,
        min: 0,
        max: 40,
        step: 0.1,
        snapPoints: [8.7, 12.3, 13.5],
        advanced: true
      },
      {
        name: 'horizontalBarsClipPercentageReset',
        label: 'Reset black bars next video',
        type: 'checkbox',
        default: true,
        advanced: true
      },
      {
        name: 'detectVideoFillScaleEnabled',
        label: 'Fill video to screen width [W]',
        type: 'checkbox',
        default: false
      },
      {
        type: 'section',
        label: 'Filters',
        name: 'sectionAmbilightImageAdjustmentCollapsed',
        default: false,
        advanced: true
      },
      {
        name: 'brightness',
        label: 'Brightness',
        type: 'list',
        default: 100,
        min: 0,
        max: 200,
        advanced: true
      },
      {
        name: 'contrast',
        label: 'Contrast',
        type: 'list',
        default: 100,
        min: 0,
        max: 200,
        advanced: true
      },
      {
        name: 'saturation',
        label: 'Saturation',
        type: 'list',
        default: 100,
        min: 0,
        max: 200,
        advanced: true
      },
      {
        type: 'section',
        label: 'Directions',
        name: 'sectionDirectionsCollapsed',
        default: true,
        advanced: true
      },
      {
        name: 'directionTopEnabled',
        label: 'Top',
        type: 'checkbox',
        default: true,
        advanced: true
      },
      {
        name: 'directionRightEnabled',
        label: 'Right',
        type: 'checkbox',
        default: true,
        advanced: true
      },
      {
        name: 'directionBottomEnabled',
        label: 'Bottom',
        type: 'checkbox',
        default: true,
        advanced: true
      },
      {
        name: 'directionLeftEnabled',
        label: 'Left',
        type: 'checkbox',
        default: true,
        advanced: true
      },
      {
        type: 'section',
        label: 'Ambilight',
        name: 'sectionAmbilightCollapsed',
        default: false
      },
      {
        name: 'blur',
        label: `
          <span style="display: inline-block; padding: 5px 0">Blur<br/>
          <span class="ytpa-menuitem-description">(More GPU memory)</span></span>`,
        type: 'list',
        default: 30,
        min: 0,
        max: 100,
        step: .1
      },
      {
        name: 'spread',
        label: `
          <span style="display: inline-block; padding: 5px 0">Spread<br/>
          <span class="ytpa-menuitem-description">(More GPU usage)</span></span>`,
        type: 'list',
        default: 17,
        min: 0,
        max: 200,
        step: .1
      },
      {
        name: 'edge',
        label: `
          <span style="display: inline-block; padding: 5px 0">Edge size<br/>
          <span class="ytpa-menuitem-description">(Less GPU usage. Tip: Turn blur down)</span></span>`,
        type: 'list',
        default: 12,
        min: 2,
        max: 50,
        step: .1,
        advanced: true
      },
      {
        name: 'bloom',
        label: 'Fade out start',
        type: 'list',
        default: 15,
        min: -50,
        max: 100,
        step: .1,
        advanced: true
      },
      {
        name: 'fadeOutEasing',
        label: `
          <span style="display: inline-block; padding: 5px 0">Fade out curve<br/>
          <span class="ytpa-menuitem-description">(Tip: Turn blur all the way down)</span></span>`,
        type: 'list',
        default: 35,
        min: 1,
        max: 100,
        step: 1,
        advanced: true
      },
      {
        name: 'debandingStrength',
        label: `
          Debanding (noise) 
          <a 
            title="Click for more information about Dithering" 
            href="https://www.lifewire.com/what-is-dithering-4686105" 
            target="_blank" 
            style="padding: 0 5px;">?</a>`,
        type: 'list',
        default: 0,
        min: 0,
        max: 100,
        advanced: true
      },
      {
        type: 'section',
        label: 'General',
        name: 'sectionGeneralCollapsed',
        default: false
      },
      {
        name: 'resetThemeToLightOnDisable',
        label: 'Switch to light theme when turned off',
        type: 'checkbox',
        default: false,
        advanced: false
      },
      {
        name: 'enableInFullscreen',
        label: `
          <span style="display: inline-block; padding: 5px 0">
            Enable in fullscreen<br/>
            <span class="ytpa-menuitem-description">(When in fullscreen mode)</span>
          </span>`,
        type: 'checkbox',
        default: true,
        advanced: true
      },
      {
        name: 'enabled',
        label: 'Enabled [A]',
        type: 'checkbox',
        default: true
      },
    ]

    this.settings = this.settings.map(setting => {
      if(this.videoHasRequestVideoFrameCallback) {
        if(setting.name === 'frameSync') {
          setting.max = 150
          setting.default = 150
          // setting.advanced = true // Change this in the future when frameSync 150 is released and validated to work
        }

        // Change this in the future when frameSync 150 is released and validated to work
        // if(setting.name === 'sectionAmbilightQualityPerformanceCollapsed') {
        //   setting.advanced = true
        // }

        // Change this in the future when frameSync 150 is released and validated to work for a long time
        // if(setting.name === 'frameSync') {
        //   return undefined
        // }
      }
      return setting
    }).filter(setting => setting)

    this.getAllSettings()
    this.initSettingsMenu()

    html.setAttribute('data-ambilight-enabled', this.enabled)
    html.setAttribute('data-ambilight-hide-scrollbar', this.hideScrollbar)
  }

  getAllSettings() {
    this.enabled = this.getSetting('enabled')

    //Sections
    this.sectionSettingsCollapsed = this.getSetting('sectionSettingsCollapsed')
    this.sectionAmbilightCollapsed = this.getSetting('sectionAmbilightCollapsed')
    this.sectionDirectionsCollapsed = this.getSetting('sectionDirectionsCollapsed')
    this.sectionAmbilightImageAdjustmentCollapsed = this.getSetting('sectionAmbilightImageAdjustmentCollapsed')
    this.sectionVideoResizingCollapsed = this.getSetting('sectionVideoResizingCollapsed')
    this.sectionHorizontalBarsCollapsed = this.getSetting('sectionHorizontalBarsCollapsed')
    this.sectionOtherPageContentCollapsed = this.getSetting('sectionOtherPageContentCollapsed')
    this.sectionAmbilightQualityPerformanceCollapsed = this.getSetting('sectionAmbilightQualityPerformanceCollapsed')
    this.sectionGeneralCollapsed = this.getSetting('sectionGeneralCollapsed')

    this.spread = this.getSetting('spread')
    this.blur = this.getSetting('blur')
    this.bloom = this.getSetting('bloom')
    this.fadeOutEasing = this.getSetting('fadeOutEasing')
    this.edge = this.getSetting('edge')
    this.innerStrength = 2
    this.videoOverlayEnabled = this.getSetting('videoOverlayEnabled')
    this.videoOverlaySyncThreshold = this.getSetting('videoOverlaySyncThreshold')

    this.contrast = this.getSetting('contrast')
    this.brightness = this.getSetting('brightness')
    this.saturation = this.getSetting('saturation')

    this.videoScale = this.getSetting('videoScale')
    this.detectHorizontalBarSizeEnabled = this.getSetting('detectHorizontalBarSizeEnabled')
    this.detectColoredHorizontalBarSizeEnabled = this.getSetting('detectColoredHorizontalBarSizeEnabled')
    this.detectHorizontalBarSizeOffsetPercentage = this.getSetting('detectHorizontalBarSizeOffsetPercentage')
    this.horizontalBarsClipPercentage = this.getSetting('horizontalBarsClipPercentage')
    this.detectVideoFillScaleEnabled = this.getSetting('detectVideoFillScaleEnabled')
    this.horizontalBarsClipPercentageReset = this.getSetting('horizontalBarsClipPercentageReset')

    this.directionTopEnabled = this.getSetting('directionTopEnabled')
    this.directionRightEnabled = this.getSetting('directionRightEnabled')
    this.directionBottomEnabled = this.getSetting('directionBottomEnabled')
    this.directionLeftEnabled = this.getSetting('directionLeftEnabled')

    //// Migrations from version 2.32
    // Enable advancedSettings for existing users
    let previouslyEnabled = false
    let previouslyAdvancedSettings = false
    try {
      previouslyEnabled = localStorage.getItem(`ambilight-enabled`)
      previouslyAdvancedSettings = localStorage.getItem(`ambilight-advancedSettings`)
    } catch (ex) {
      console.warn('YouTube Ambilight | getSetting', ex)
      //AmbilightSentry.captureExceptionWithDetails(ex)
    }
    if(previouslyAdvancedSettings === null) {
      this.setSetting('advancedSettings', (previouslyEnabled !== null))
    } else {
      this.advancedSettings = this.getSetting('advancedSettings')
    }

    // Migrate highQuality to frameSync
    const previouslyHighQuality = this.getSetting('highQuality')
    if(previouslyHighQuality === 'false') {
      this.setSetting('frameSync', 0)
      this.removeSetting('highQuality')
    } else {
      this.frameSync = this.getSetting('frameSync')
    }

    this.framerateLimit = this.getSetting('framerateLimit')
    this.frameBlending = this.getSetting('frameBlending')
    this.frameBlendingSmoothness = this.getSetting('frameBlendingSmoothness')
    this.immersive = this.getSetting('immersive')
    this.immersiveTheaterView = this.getSetting('immersiveTheaterView')
    this.hideScrollbar = this.getSetting('hideScrollbar')
    this.enableInFullscreen = this.getSetting('enableInFullscreen')
    this.resetThemeToLightOnDisable = this.getSetting('resetThemeToLightOnDisable')
    this.showFPS = this.getSetting('showFPS')

    this.surroundingContentTextAndBtnOnly = this.getSetting('surroundingContentTextAndBtnOnly')
    this.surroundingContentShadowSize = this.getSetting('surroundingContentShadowSize')
    this.surroundingContentShadowOpacity = this.getSetting('surroundingContentShadowOpacity')
    this.surroundingContentImagesTransparency = this.getSetting('surroundingContentImagesTransparency')
    this.debandingStrength = this.getSetting('debandingStrength')

    this.videoShadowSize = this.getSetting('videoShadowSize')
    this.videoShadowOpacity = this.getSetting('videoShadowOpacity')

    this.settings.forEach(setting => {
      setting.value = this[setting.name]
    })
  }

  initFPSListElem() {
    if (this.videoSyncedElem && this.videoSyncedElem.isConnected) return

    this.FPSListElem = document.createElement('div')
    this.FPSListElem.classList.add('ambilight__fps-list')

    this.displayFPSElem = document.createElement('div')
    this.displayFPSElem.classList.add('ambilight__display-fps')
    this.FPSListElem.prepend(this.displayFPSElem)

    this.ambilightDroppedFramesElem = document.createElement('div')
    this.ambilightDroppedFramesElem.classList.add('ambilight__ambilight-dropped-frames')
    this.FPSListElem.prepend(this.ambilightDroppedFramesElem)

    this.ambilightFPSElem = document.createElement('div')
    this.ambilightFPSElem.classList.add('ambilight__ambilight-fps')
    this.FPSListElem.prepend(this.ambilightFPSElem)

    this.videoSyncedElem = document.createElement('div')
    this.videoSyncedElem.classList.add('ambilight__video-synced')
    this.FPSListElem.prepend(this.videoSyncedElem)

    this.videoDroppedFramesElem = document.createElement('div')
    this.videoDroppedFramesElem.classList.add('ambilight__video-dropped-frames')
    this.FPSListElem.prepend(this.videoDroppedFramesElem)

    this.videoFPSElem = document.createElement('div')
    this.videoFPSElem.classList.add('ambilight__video-fps')
    this.FPSListElem.prepend(this.videoFPSElem)

    this.videoPlayerElem.prepend(this.FPSListElem)
  }

  initVideoOverlay() {
    const videoOverlayElem = new Canvas(1, 1)
    videoOverlayElem.classList.add('ambilight__video-overlay')
    this.videoOverlay = {
      elem: videoOverlayElem,
      ctx: videoOverlayElem.getContext('2d', { ...ctxOptions, alpha: true }),
      isHiddenChangeTimestamp: 0
    }
  }

  initFrameBlending() {
    //this.previousProjectorBuffer
    const previousProjectorsBufferElem = new Canvas(1, 1, true) 
    if (previousProjectorsBufferElem.tagName === 'CANVAS') {
      this.buffersWrapperElem.appendChild(previousProjectorsBufferElem)
    }
    this.previousProjectorBuffer = {
      elem: previousProjectorsBufferElem,
      ctx: previousProjectorsBufferElem.getContext('2d', { ...ctxOptions, alpha: true })
    }

    //this.blendedProjectorBuffer
    const blendedProjectorsBufferElem = new Canvas(1, 1, true) 
    if (blendedProjectorsBufferElem.tagName === 'CANVAS') {
      this.buffersWrapperElem.appendChild(blendedProjectorsBufferElem)
    }
    this.blendedProjectorBuffer = {
      elem: blendedProjectorsBufferElem,
      ctx: blendedProjectorsBufferElem.getContext('2d', { ...ctxOptions, alpha: true })
    }
  }

  initVideoOverlayWithFrameBlending() {
    //this.videoOverlayBuffer
    const videoOverlayBufferElem = new Canvas(1, 1, true) 
    if (videoOverlayBufferElem.tagName === 'CANVAS') {
      this.buffersWrapperElem.appendChild(videoOverlayBufferElem)
    }
    this.videoOverlayBuffer = {
      elem: videoOverlayBufferElem,
      ctx: videoOverlayBufferElem.getContext('2d', { ...ctxOptions, alpha: true })
    }

    //this.previousVideoOverlayBuffer
    const previousVideoOverlayBufferElem = new Canvas(1, 1, true) 
    if (previousVideoOverlayBufferElem.tagName === 'CANVAS') {
      this.buffersWrapperElem.appendChild(previousVideoOverlayBufferElem)
    }
    this.previousVideoOverlayBuffer = {
      elem: previousVideoOverlayBufferElem,
      ctx: previousVideoOverlayBufferElem.getContext('2d', { ...ctxOptions, alpha: true })
    }
  }

  resetSettingsIfNeeded() {
    const videoPath = location.search
    if (!this.prevVideoPath || videoPath !== this.prevVideoPath) {
      if (this.horizontalBarsClipPercentageReset) {
        this.setHorizontalBars(0)
      }
      if(this.detectVideoFillScaleEnabled) {
        this.setSetting('videoScale', 100)
      }
    }
    this.prevVideoPath = videoPath
  }

  setHorizontalBars(percentage) {
    if(this.horizontalBarsClipPercentage === percentage) return

    this.horizontalBarsClipPercentage = percentage
    this.sizesInvalidated = true
    this.optionalFrame()
    setTimeout(() => {
      this.setSetting('horizontalBarsClipPercentage', percentage)
      const rangeInput = $.s('#setting-horizontalBarsClipPercentage-range')
      if(rangeInput) {
        rangeInput.value = percentage
        $.s(`#setting-horizontalBarsClipPercentage-value`).textContent = `${percentage}%`
      }
    }, 1)
  }

  initFeedbackLink() {
    const version = html.getAttribute('data-ambilight-version') || ''
    const os = html.getAttribute('data-ambilight-os') || ''
    const browser = html.getAttribute('data-ambilight-browser') || ''
    this.feedbackFormLink = `https://docs.google.com/forms/d/e/1FAIpQLSe5lenJCbDFgJKwYuK_7U_s5wN3D78CEP5LYf2lghWwoE9IyA/viewform?usp=pp_url&entry.1590539866=${version}&entry.1676661118=${os}&entry.964326861=${browser}`
  }

  clear() {
    // Clear canvasses
    const canvasses = [
      this.videoSnapshotBuffer,
      this.videoSnapshotGetImageDataBuffer,
      this.projector
    ]
    if(this.previousProjectorBuffer) {
      canvasses.push(this.previousProjectorBuffer)
      canvasses.push(this.blendedProjectorBuffer)
    }
    if(this.videoOverlay) {
      canvasses.push(this.videoOverlay)
      if(this.videoOverlayBuffer) {
        canvasses.push(this.videoOverlayBuffer)
        canvasses.push(this.previousVideoOverlayBuffer)
      }
    }
    canvasses.forEach(({ ctx, elem }) => {
      // ctx.clearRect(0, 0, elem.width, elem.height)
      elem.width = 1;
    })

    this.buffersCleared = true
    this.sizesInvalidated = true
    this.checkIfNeedToHideVideoOverlay()
    this.scheduleNextFrame()
  }

  detectVideoFillScale() {
    let videoScale = 100
    if(this.videoElem.offsetWidth && this.videoElem.offsetHeight) {
      if(this.videoPlayerElem) {
        const videoScaleY = (100 - (this.horizontalBarsClipPercentage * 2)) / 100
        const videoWidth = this.videoElem.offsetWidth
        const videoHeight = this.videoElem.offsetHeight * videoScaleY
        const containerWidth = this.videoPlayerElem.offsetWidth
        const containerHeight = this.videoPlayerElem.offsetHeight
        const scaleX = containerWidth / videoWidth
        const scaleY = containerHeight / videoHeight

        videoScale = Math.round(Math.min(scaleX, scaleY) * 10000) / 100
        if(isNaN(videoScale)) {
          videoScale = 100
        }
        if(videoScale < 100.5) {
          videoScale = 100
        }
      }
    }
    if(this.videoScale === videoScale) return

    this.setSetting('videoScale', videoScale)
    if($.s('#setting-videoScale')) {
      $.s('#setting-videoScale-range').value = videoScale
      $.s(`#setting-videoScale-value`).textContent = `${videoScale}%`
    }
  }

  updateView() {
    // const prevView = this.view
    if(document.contains(this.videoPlayerElem)) {
      if(this.videoPlayerElem.classList.contains('ytp-fullscreen'))
        this.view = this.VIEW_FULLSCREEN
      else if(this.videoPlayerElem.classList.contains('ytp-player-minimized'))
        this.view = this.VIEW_POPUP
      else if(
        (this.ytdWatchFlexyElem && this.ytdWatchFlexyElem.getAttribute('theater') !== null) ||
        (this.pageElem && this.pageElem.classList.contains('watch-stage-mode'))
      )
        this.view = this.VIEW_THEATER
      else
        this.view = this.VIEW_SMALL
    } else {
      this.view = this.VIEW_DETACHED
    }
    // Todo: Set the settings for the specific view
    // if(prevView !== this.view) {
    //   console.log('VIEW CHANGED: ', this.view)
    //   this.getAllSettings()
    // }
  }

  updateSizes() {
    if(this.detectVideoFillScaleEnabled){
      this.detectVideoFillScale()
    }

    this.updateView()
    this.isVR = this.videoPlayerElem.classList.contains('ytp-webgl-spherical')
    this.isFullscreen = (this.view == this.VIEW_FULLSCREEN)
    const noClipOrScale = (this.horizontalBarsClipPercentage == 0 && this.videoScale == 100)
    this.isFillingFullscreen = (
      this.isFullscreen &&
      this.atTop &&
      Math.abs(this.videoOffset.width - window.innerWidth) < 10 &&
      Math.abs(this.videoOffset.height - window.innerHeight) < 10 &&
      noClipOrScale
    )

    const videoElemParentElem = this.videoElem.parentNode

    const notVisible = (
      !this.enabled ||
      this.isVR ||
      !videoElemParentElem ||
      !this.videoPlayerElem ||
      this.videoPlayerElem.classList.contains('ytp-player-minimized') ||
      (this.isFullscreen && !this.enableInFullscreen)
    )
    if (notVisible || noClipOrScale) {
      this.resetVideoContainerStyle()
    }
    if (notVisible) {
      this.hide()
      return true
    }
    
    if(this.isFullscreen) {
      if(this.elem.parentElement !== this.ytdAppElem) {
        this.ytdAppElem.prepend(this.elem)
      }
    } else {
      if(this.elem.parentElement !== body) {
        body.prepend(this.elem)
      }
    }

    const horizontalBarsClip = this.horizontalBarsClipPercentage / 100
    const shouldStyleVideoContainer = !this.isVideoHiddenOnWatchPage && !this.videoElem.ended && !noClipOrScale
    if (shouldStyleVideoContainer) {
      const top = Math.max(0, parseInt(this.videoElem.style.top))
      videoElemParentElem.style.height = `${this.videoElem.offsetHeight}px`
      videoElemParentElem.style.marginBottom = `${-this.videoElem.offsetHeight}px`
      videoElemParentElem.style.overflow = 'hidden'

      this.horizontalBarsClipScaleY = (1 - (horizontalBarsClip * 2))
      videoElemParentElem.style.transform =  `
        translateY(${top}px) 
        scale(${(this.videoScale / 100)}) 
        scaleY(${this.horizontalBarsClipScaleY})
      `
      videoElemParentElem.style.setProperty('--video-transform', `
        translateY(${-top}px) 
        scaleY(${(Math.round(1000 * (1 / this.horizontalBarsClipScaleY)) / 1000)})
      `)
    }

    this.videoOffset = this.getElemRect(this.videoElem)
    if (
      this.videoOffset.top === undefined ||
      !this.videoOffset.width ||
      !this.videoOffset.height ||
      !this.videoElem.videoWidth ||
      !this.videoElem.videoHeight
    ) return false //Not ready

    this.srcVideoOffset = {
      top: this.videoOffset.top,
      width: this.videoElem.videoWidth,
      height: this.videoElem.videoHeight
    }

    const minSize = 384
    const scaleX = this.srcVideoOffset.width / minSize
    const scaleY = this.srcVideoOffset.height / minSize
    const scale = Math.min(scaleX, scaleY)
    // A size of > 256 is required to enable keep GPU acceleration enabled in Chrome
    // A side with a size of <= 512 is required to enable GPU acceleration in Chrome
    if (scale < 1) {
      this.p = {
        w: minSize,
        h: minSize
      }
    } else {
      this.p = {
        w: Math.round(this.srcVideoOffset.width / scale),
        h: Math.round((this.srcVideoOffset.height) / scale) // * (1 - (horizontalBarsClip * 2))
      }
    }

    const unscaledWidth = Math.round(this.videoOffset.width / (this.videoScale / 100))
    const unscaledHeight = Math.round(this.videoOffset.height / (this.videoScale / 100))
    const unscaledLeft = Math.round(
      (this.videoOffset.left + window.scrollX) - 
      ((unscaledWidth - this.videoOffset.width) / 2)
    )
    const unscaledTop = Math.round(
      this.videoOffset.top - 
      ((unscaledHeight - this.videoOffset.height) / 2)
    )

    this.horizontalBarsClipScaleY = (1 - (horizontalBarsClip * 2))
    this.projectorsElem.style.left = `${unscaledLeft}px`
    this.projectorsElem.style.top = `${unscaledTop - 1}px`
    this.projectorsElem.style.width = `${unscaledWidth}px`
    this.projectorsElem.style.height = `${unscaledHeight}px`
    this.projectorsElem.style.transform = `
      scale(${(this.videoScale / 100)}) 
      scaleY(${this.horizontalBarsClipScaleY})
    `
    
    if(this.videoShadowOpacity != 0 && this.videoShadowSize != 0) {
      this.videoShadowElem.style.display = 'block'
      this.videoShadowElem.style.left = `${unscaledLeft}px`
      this.videoShadowElem.style.top = `${unscaledTop}px`
      this.videoShadowElem.style.width = `${unscaledWidth}px`
      this.videoShadowElem.style.height = `${(unscaledHeight * this.horizontalBarsClipScaleY)}px`
      this.videoShadowElem.style.transform = `
        translate3d(0,0,0) 
        translateY(${(unscaledHeight * horizontalBarsClip)}px) 
        scale(${(this.videoScale / 100)})
      `
    } else {
      this.videoShadowElem.style.display = ''
    }

    this.filterElem.style.filter = `
      ${(this.contrast != 100) ? `contrast(${this.contrast}%)` : ''}
      ${(this.brightness != 100) ? `brightness(${this.brightness}%)` : ''}
      ${(this.saturation != 100) ? `saturate(${this.saturation}%)` : ''}
    `.trim()

    this.filterBlurPx = (this.blur != 0) ? this.p.h * (Math.pow(this.blur, 1.75) * .00015) : 0

    this.resizeCanvasses()

    const pWidth = Math.round((this.p.w + this.filterBlurPx * 2) * this.projectorOuterScale.x)
    const pHeight = Math.round((this.p.h + this.filterBlurPx * 2) * this.projectorOuterScale.y)

    this.blurBuffer.elem.width = this.p.w + this.filterBlurPx * 4
    this.blurBuffer.elem.height = this.p.h + this.filterBlurPx * 4
    // this.blurBuffer.ctx.filter = (this.filterBlurPx != 0) ? `blur(${this.filterBlurPx}px)` : 'none'
    
    this.projectorBlurBuffer.elem.width = pWidth
    this.projectorBlurBuffer.elem.height = pHeight
    
    this.projectorBuffer.elem.width = pWidth
    this.projectorBuffer.elem.height = pHeight
    this.blurBuffer.ctx.filter = (this.filterBlurPx != 0) ? `blur(${this.filterBlurPx * (this.projectorOuterScale.y / this.projectorScale.y)}px)` : 'none'
    
    if (this.projector.elem.width !== pWidth)
      this.projector.elem.width = pWidth
    if (this.projector.elem.height !== pHeight)
      this.projector.elem.height = pHeight


    if (this.frameBlending) {
      if(!this.previousProjectorBuffer || !this.blendedProjectorBuffer) {
        this.initFrameBlending()
      }
      this.previousProjectorBuffer.elem.width = pWidth
      this.previousProjectorBuffer.elem.height = pHeight
      this.blendedProjectorBuffer.elem.width = pWidth
      this.blendedProjectorBuffer.elem.height = pHeight
    }
    if (this.videoOverlayEnabled && !this.videoOverlay) {
      this.initVideoOverlay()
    }
    if (this.videoOverlayEnabled && this.frameBlending && !this.previousVideoOverlayBuffer) {
      this.initVideoOverlayWithFrameBlending()
    }
    if (this.videoOverlayEnabled)
      this.checkIfNeedToHideVideoOverlay()

    if (this.videoOverlayEnabled && this.videoOverlay && !this.videoOverlay.elem.parentNode) {
      this.videoContainerElem.appendChild(this.videoOverlay.elem)
    } else if (!this.videoOverlayEnabled && this.videoOverlay && this.videoOverlay.elem.parentNode) {
      this.videoOverlay.elem.parentNode.removeChild(this.videoOverlay.elem)
    }
    if (this.videoOverlayEnabled && this.videoOverlay) {
      this.videoOverlay.elem.setAttribute('style', this.videoElem.getAttribute('style'))
      this.videoOverlay.elem.width = this.srcVideoOffset.width
      this.videoOverlay.elem.height = this.srcVideoOffset.height

      if (this.frameBlending) {
        this.videoOverlayBuffer.elem.width = this.srcVideoOffset.width
        this.videoOverlayBuffer.elem.height = this.srcVideoOffset.height

        this.previousVideoOverlayBuffer.elem.width = this.srcVideoOffset.width
        this.previousVideoOverlayBuffer.elem.height = this.srcVideoOffset.height
      }
    }

    this.videoSnapshotBuffer.elem.width = this.p.w
    this.videoSnapshotBuffer.elem.height = this.p.h
    this.videoSnapshotGetImageDataBuffer.elem.width = this.p.w
    this.videoSnapshotGetImageDataBuffer.elem.height = this.p.h
    this.videoSnapshotBufferBarsClipPx = Math.round(this.videoSnapshotBuffer.elem.height * horizontalBarsClip)

    this.initFPSListElem()

    this.sizesInvalidated = false
    this.buffersCleared = true
    return true
  }

  resetVideoContainerStyle() {
    const videoContainer = this.videoElem.parentElement
    if (videoContainer) {
      videoContainer.style.transform = ''
      videoContainer.style.overflow = ''
      videoContainer.style.height = ''
      videoContainer.style.marginBottom = ''
      videoContainer.style.setProperty('--video-transform', '')
    }
  }

  updateStyles() {
    // Images transparency

    const ImagesTransparency = this.surroundingContentImagesTransparency
    const imageOpacity = (ImagesTransparency) ? (1 - (ImagesTransparency / 100)) : ''
    document.body.style.setProperty('--ambilight-image-opacity', imageOpacity)


    // Content shadow

    const textAndBtnOnly = this.surroundingContentTextAndBtnOnly
    const shadowSize = this.surroundingContentShadowSize / 5
    const shadowOpacity = this.surroundingContentShadowOpacity / 100

    // All
    const getFilterShadow = (color) => (shadowSize && shadowOpacity) 
      ? (
        (shadowOpacity > .5) 
        ? `
          drop-shadow(0 0 ${shadowSize}px rgba(${color},${shadowOpacity})) 
          drop-shadow(0 0 ${shadowSize}px rgba(${color},${shadowOpacity}))
        `
        : `drop-shadow(0 0 ${shadowSize}px rgba(${color},${shadowOpacity * 2}))`
      )
      : ''
    document.body.style.setProperty(`--ambilight-filter-shadow`, (!textAndBtnOnly ? getFilterShadow('0,0,0') : ''))
    document.body.style.setProperty(`--ambilight-filter-shadow-inverted`, (!textAndBtnOnly ? getFilterShadow('255,255,255') : ''))
    
    // Text and buttons only
    document.body.style.setProperty(`--ambilight-button-shadow`, (textAndBtnOnly ? getFilterShadow('0,0,0') : ''))
    document.body.style.setProperty(`--ambilight-button-shadow-inverted`, (textAndBtnOnly ? getFilterShadow('255,255,255') : ''))
    const getTextShadow = (color) => (shadowSize && shadowOpacity) 
      ? `
        rgba(${color},${shadowOpacity}) 0 0 ${shadowSize * 2}px,
        rgba(${color},${shadowOpacity}) 0 0 ${shadowSize * 2}px
      `
      : ''
    document.body.style.setProperty('--ambilight-text-shadow', (textAndBtnOnly ? getTextShadow('0,0,0') : ''))
    document.body.style.setProperty('--ambilight-text-shadow-inverted', (textAndBtnOnly ? getTextShadow('255,255,255') : ''))


    // Video shadow
    
    const videoShadowSize = parseFloat(this.videoShadowSize, 10) / 2 + Math.pow(this.videoShadowSize / 5, 1.77) // Chrome limit: 250px | Firefox limit: 100px
    const videoShadowOpacity = this.videoShadowOpacity / 100
    
    document.body.style.setProperty('--ambilight-video-shadow-background', 
      (videoShadowSize && videoShadowOpacity) ? `rgba(0,0,0,${videoShadowOpacity})` : '')
    document.body.style.setProperty('--ambilight-video-shadow-box-shadow', 
      (videoShadowSize && videoShadowOpacity)
        ? `
          rgba(0,0,0,${videoShadowOpacity}) 0 0 ${videoShadowSize}px,
          rgba(0,0,0,${videoShadowOpacity}) 0 0 ${videoShadowSize}px
        `
        : '')


    // Video scale

    document.body.style.setProperty('--ambilight-html5-video-player-overflow', 
      (this.videoScale > 100) ?  'visible' : '')


    // Debanding

    const baseurl = html.getAttribute('data-ambilight-baseurl') || ''
    const debandingStrength = parseFloat(this.debandingStrength)
    const noiseImageIndex = (debandingStrength > 75) ? 3 : (debandingStrength > 50) ? 2 : 1
    const noiseOpacity =  debandingStrength / ((debandingStrength > 75) ? 100 : (debandingStrength > 50) ? 75 : 50)

    document.body.style.setProperty('--ambilight-debanding-content', 
      debandingStrength ? `''` : '')
    document.body.style.setProperty('--ambilight-debanding-background', 
      debandingStrength ? `url('${baseurl}images/noise-${noiseImageIndex}.png')` : '')
    document.body.style.setProperty('--ambilight-debanding-opacity', 
      debandingStrength ? noiseOpacity : '')
  }

  resizeCanvasses() {
    this.videoProjectorOffset = {
      w: this.videoOffset.width,
      h: this.videoOffset.height * this.horizontalBarsClipScaleY
    }
    this.projectorOffset = {
      w: this.videoProjectorOffset.w + this.filterBlurPx * 4,
      h: this.videoProjectorOffset.h + this.filterBlurPx * 4
    }
    this.ratio = (this.videoProjectorOffset.w > this.videoProjectorOffset.h) ?
      {
        x: 1,
        y: (this.videoProjectorOffset.w / this.videoProjectorOffset.h)
      } : {
        x: (this.videoProjectorOffset.h / this.videoProjectorOffset.w),
        y: 1
      }

    this.spreadLevels = Math.max(2, Math.round((this.spread / this.edge)) + this.innerStrength + 1)
    const pos = (this.spreadLevels - 1) - this.innerStrength
    this.scaleStep = this.edge / 100

    let scaleX = 1
    let scaleY = 1
    if (pos > 0) {
      scaleX = 1 + ((this.scaleStep * this.ratio.x) * pos)
      scaleY = 1 + ((this.scaleStep * this.ratio.y) * pos)
    } else if (pos < 0) {
      scaleX = 1 - ((this.scaleStep * this.ratio.x) * -pos)
      scaleY = 1 - ((this.scaleStep * this.ratio.y) * -pos)
      if (scaleX < 0) scaleX = 0
      if (scaleY < 0) scaleY = 0
    }

    //To prevent 0x0 sized canvas elements causing a GPU memory leak
    this.projectorOuterScaleMin = {
      x: 1/this.projectorOffset.w,
      y: 1/this.projectorOffset.h
    }

    // Todo: Add blur sizes
    this.projectorOuterScale = {
      x: Math.max(this.projectorOuterScaleMin.x, scaleX * (this.projectorOffset.w / this.videoProjectorOffset.w)),
      y: Math.max(this.projectorOuterScaleMin.y, scaleY * (this.projectorOffset.h / this.videoProjectorOffset.h))
    }
    this.projectorScale = {
      x: this.projectorOuterScale.x * (this.videoProjectorOffset.w / this.projectorOffset.w),
      y: this.projectorOuterScale.y * (this.videoProjectorOffset.h / this.projectorOffset.h)
    }

    this.projector.elem.style.transform = `scale(${this.projectorOuterScale.x}, ${this.projectorOuterScale.y})`
    this.shadow.elem.style.transform = `scale(${this.projectorOuterScale.x}, ${this.projectorOuterScale.y})`

    this.updateShadow()
  }

  updateShadow() {
    const video = this.videoProjectorOffset
    const projectorOuter = {
      w: Math.floor(video.w * this.projectorOuterScale.x),
      h: Math.floor(video.h * this.projectorOuterScale.y)
    }
    const projector = {
      w: Math.floor(video.w * this.projectorScale.x),
      h: Math.floor(video.h * this.projectorScale.y)
    }
    const edge = {
      w: Math.ceil((projector.w - video.w) / 2),
      h: Math.ceil((projector.h - video.h) / 2)
    }
    const projectorMax = 1920
    const maxScale = Math.min(1, projectorMax / projector.w, projectorMax / projector.h)
    const scale = {
      x: maxScale, // this.shadow.elem.width / (video.w + edge.w + edge.w),
      y: maxScale // this.shadow.elem.height / (video.h + edge.h + edge.h)
    }

    let fadeOutFrom = this.bloom / 100
    const fadeOutMinH = -(video.h / 2 / edge.h)
    const fadeOutMinW = -(video.w / 2 / edge.w)
    fadeOutFrom = Math.max(fadeOutFrom, fadeOutMinH, fadeOutMinW)

    const shadowCenter = {
      x: (edge.w - (edge.w * fadeOutFrom)) * scale.x,
      y: (edge.h - (edge.h * fadeOutFrom)) * scale.y,
      w: (video.w + ((edge.w * 2) * fadeOutFrom)) * scale.x,
      h: (video.h + ((edge.h * 2) * fadeOutFrom)) * scale.y,
    }
    const videoCenter = {
      x: edge.w * scale.x,
      y: edge.h * scale.y,
      w: video.w * scale.x,
      h: video.h * scale.y,
    }
  
    // Create gradient stops
    const darkest = 1
    const easing = (16 / (this.fadeOutEasing * .64))
    const stopsLength = 256
    let stops = []
    for (let i = 0; i <= stopsLength; i++) {
      stops.push({
        p: (i / stopsLength),
        o: Math.pow((stopsLength - i) / stopsLength, easing) * darkest
      })
    }
    stops = stops.map(({p, o}) => ({
      p: (Math.round(p * 10000) / 10000),
      o: (Math.round(o * 10000) / 10000)
    }))


    // Draw side shadow
    this.sideShadowBuffer.elem.width = Math.max(1, shadowCenter.x)
    this.sideShadowBuffer.elem.height = 1
    this.sideShadowBuffer.ctx.clearRect(0, 0, this.sideShadowBuffer.elem.width, this.sideShadowBuffer.elem.height)
    const sideGradient = this.sideShadowBuffer.ctx.createLinearGradient(0, 0, this.sideShadowBuffer.elem.width, 0)
    stops.forEach(({ p, o }) => sideGradient.addColorStop(p, `rgba(0,0,0,${o})`))
    this.sideShadowBuffer.ctx.fillStyle = sideGradient
    this.sideShadowBuffer.ctx.fillRect(0, 0, this.sideShadowBuffer.elem.width, this.sideShadowBuffer.elem.height)


    // Draw corner shadow
    const largestCenterSide = Math.max(shadowCenter.x, shadowCenter.y)
    const largestFadeOut = Math.max(((edge.w * fadeOutFrom) * scale.x), ((edge.h * fadeOutFrom)) * scale.y)
    this.cornerShadowBuffer.elem.width = Math.max(1, (largestCenterSide + largestFadeOut))
    this.cornerShadowBuffer.elem.height = Math.max(1, (largestCenterSide + largestFadeOut))
    this.cornerShadowBuffer.ctx.clearRect(0, 0, this.cornerShadowBuffer.elem.width, this.cornerShadowBuffer.elem.height)
    const cornerGradient = this.sideShadowBuffer.ctx.createRadialGradient(
      this.cornerShadowBuffer.elem.width, this.cornerShadowBuffer.elem.height, this.cornerShadowBuffer.elem.width,
      this.cornerShadowBuffer.elem.width, this.cornerShadowBuffer.elem.height, Math.min(this.cornerShadowBuffer.elem.width - 1, Math.max(0, largestFadeOut))
    )
    stops.forEach(({ p, o }) => cornerGradient.addColorStop(p, `rgba(0,0,0,${o})`))
    this.cornerShadowBuffer.ctx.fillStyle = cornerGradient
    this.cornerShadowBuffer.ctx.fillRect(0, 0, this.cornerShadowBuffer.elem.width, this.cornerShadowBuffer.elem.height)


    //// Draw shadows
    this.shadowBuffer.ctx.clearRect(0, 0, this.shadowBuffer.elem.width, this.shadowBuffer.elem.height)
    this.shadowBuffer.elem.width = Math.floor(projector.w * scale.x)
    this.shadowBuffer.elem.height = Math.floor(projector.h * scale.y)

    const drawCornerShadow = () => {
      const w = Math.max(shadowCenter.x, videoCenter.x)
      const h = Math.max(shadowCenter.y, videoCenter.y)
      if (w <= 0 || h <= 0) return
      this.shadowBuffer.ctx.clearRect(0, 0, w, h)
      this.shadowBuffer.ctx.drawImage(this.cornerShadowBuffer.elem,
        0, 0, w, h
      )
    }
    const drawVerticalShadow = () => {
      const w = shadowCenter.x
      const h = Math.min(shadowCenter.h, videoCenter.h)
      if (w <= 0 || h <= 0) return
      this.shadowBuffer.ctx.drawImage(this.sideShadowBuffer.elem,
        0, Math.max(shadowCenter.y, videoCenter.y), w, h
      )
    }
    const drawHorizontalShadow = () => {
      if (shadowCenter.y === 0 || videoCenter.w === 0) return
      this.shadowBuffer.ctx.drawImage(this.sideShadowBuffer.elem,
        0, Math.min(shadowCenter.x, videoCenter.x), shadowCenter.y, Math.max(shadowCenter.w, videoCenter.w)
      )
    }

    const rotate = (times, callback) => {
      for(let i = times; i > 0; i -= 2) {
        this.shadowBuffer.ctx.translate(this.shadowBuffer.elem.width, 0)
        this.shadowBuffer.ctx.rotate(90 * Math.PI / 180)
        if(i > 1) {
          this.shadowBuffer.ctx.translate(this.shadowBuffer.elem.height, 0)
          this.shadowBuffer.ctx.rotate(90 * Math.PI / 180)
        }
      }
      callback()
      for(let i = times; i >= 0; i -= 2) {
        if((i < times || i % 2 === 1)) {
          this.shadowBuffer.ctx.rotate(-90 * Math.PI / 180)
          this.shadowBuffer.ctx.translate(-this.shadowBuffer.elem.width, 0)
        }
        if(i > 1) {
          this.shadowBuffer.ctx.rotate(-90 * Math.PI / 180)
          this.shadowBuffer.ctx.translate(-this.shadowBuffer.elem.height, 0)
        }
      }
    }

    rotate(0, () => drawVerticalShadow())
    rotate(1, () => drawHorizontalShadow())
    rotate(2, () => drawVerticalShadow())
    rotate(3, () => drawHorizontalShadow())

    rotate(0, () => drawCornerShadow())
    rotate(1, () => drawCornerShadow())
    rotate(2, () => drawCornerShadow())
    rotate(3, () => drawCornerShadow())


    // Blur shadow
    const shadowBlur = this.filterBlurPx * scale.y
    const shadowOuterBlur = shadowBlur * (this.projectorOuterScale.y / this.projectorScale.y)
    // console.log('shadowBlur', shadowBlur, this.filterBlurPx, this.projectorScale.y, scale.y)
    const shadowOuterBlurBorder = (shadowOuterBlur * 4)
  
    this.shadowPreBlurBuffer.ctx.clearRect(0, 0, this.shadowPreBlurBuffer.elem.width, this.shadowPreBlurBuffer.elem.height)
    this.shadowPreBlurBuffer.elem.width = this.shadowBuffer.elem.width + shadowOuterBlurBorder * 2
    this.shadowPreBlurBuffer.elem.height = this.shadowBuffer.elem.height + shadowOuterBlurBorder * 2
    this.shadowPreBlurBuffer.ctx.fillStyle = '#000'
    this.shadowPreBlurBuffer.ctx.fillRect(0, 0, shadowOuterBlurBorder, this.shadowPreBlurBuffer.elem.height)
    this.shadowPreBlurBuffer.ctx.fillRect((this.shadowPreBlurBuffer.elem.width - shadowOuterBlurBorder), 0, shadowOuterBlurBorder, this.shadowPreBlurBuffer.elem.height)
    this.shadowPreBlurBuffer.ctx.fillRect(0, 0, this.shadowPreBlurBuffer.elem.width, shadowOuterBlurBorder)
    this.shadowPreBlurBuffer.ctx.fillRect(0, (this.shadowPreBlurBuffer.elem.height - shadowOuterBlurBorder), this.shadowPreBlurBuffer.elem.width, shadowOuterBlurBorder)
    this.shadowPreBlurBuffer.ctx.drawImage(this.shadowBuffer.elem, shadowOuterBlurBorder, shadowOuterBlurBorder)
    
    this.shadowBlurBuffer.ctx.clearRect(0, 0, this.shadowBlurBuffer.elem.width, this.shadowBlurBuffer.elem.height)
    this.shadowBlurBuffer.elem.width = this.shadowPreBlurBuffer.elem.width
    this.shadowBlurBuffer.elem.height = this.shadowPreBlurBuffer.elem.height
    this.shadowBlurBuffer.ctx.filter = (shadowOuterBlur != 0) ? `blur(${shadowOuterBlur}px)` : 'none'
    this.shadowBlurBuffer.ctx.drawImage(this.shadowPreBlurBuffer.elem, 0, 0)

    this.shadow.ctx.clearRect(0, 0, this.shadow.elem.width, this.shadow.elem.height)
    this.shadow.elem.width = this.shadowBlurBuffer.elem.width
    this.shadow.elem.height = this.shadowBlurBuffer.elem.height
    this.shadow.ctx.drawImage(this.shadowBlurBuffer.elem,
      0, 0
    )
    

    // Blackout disabled directions
    this.shadow.ctx.fillStyle = '#000000'

    if(!this.directionTopEnabled) {
      this.shadow.ctx.beginPath()

      this.shadow.ctx.moveTo(0, 0)
      this.shadow.ctx.lineTo(scale.x * (edge.w),                     scale.y * (edge.h))
      this.shadow.ctx.lineTo(scale.x * (edge.w + (video.w / 2)),     scale.y * (edge.h + (video.h / 2)))
      this.shadow.ctx.lineTo(scale.x * (edge.w + video.w),           scale.y * (edge.h))
      this.shadow.ctx.lineTo(scale.x * (edge.w + video.w + edge.w),  0)
      
      this.shadow.ctx.fill()
    }

    if(!this.directionRightEnabled) {
      this.shadow.ctx.beginPath()

      this.shadow.ctx.lineTo(scale.x * (edge.w + video.w + edge.w),  0)
      this.shadow.ctx.lineTo(scale.x * (edge.w + video.w),           scale.y * (edge.h))
      this.shadow.ctx.lineTo(scale.x * (edge.w + (video.w / 2)),     scale.y * (edge.h + (video.h / 2)))
      this.shadow.ctx.lineTo(scale.x * (edge.w + video.w),           scale.y * (edge.h + video.h))
      this.shadow.ctx.lineTo(scale.x * (edge.w + video.w + edge.w),  scale.y * (edge.h + video.h + edge.h))
      
      this.shadow.ctx.fill()
    }

    if(!this.directionBottomEnabled) {
      this.shadow.ctx.beginPath()

      this.shadow.ctx.moveTo(0,                                     scale.y * (edge.h + video.h + edge.h))
      this.shadow.ctx.lineTo(scale.x * (edge.w),                     scale.y * (edge.h + video.h))
      this.shadow.ctx.lineTo(scale.x * (edge.w + (video.w / 2)),     scale.y * (edge.h + (video.h / 2)))
      this.shadow.ctx.lineTo(scale.x * (edge.w + video.w),           scale.y * (edge.h + video.h))
      this.shadow.ctx.lineTo(scale.x * (edge.w + video.w + edge.w),  scale.y * (edge.h + video.h + edge.h))
      
      this.shadow.ctx.fill()
    }

    if(!this.directionLeftEnabled) {
      this.shadow.ctx.beginPath()

      this.shadow.ctx.moveTo(0,                                     0)
      this.shadow.ctx.lineTo(scale.x * (edge.w),                     scale.y * (edge.h))
      this.shadow.ctx.lineTo(scale.x * (edge.w + (video.w / 2)),     scale.y * (edge.h + (video.h / 2)))
      this.shadow.ctx.lineTo(scale.x * (edge.w),                     scale.y * (edge.h + video.h))
      this.shadow.ctx.lineTo(0,                                     scale.y * (edge.h + video.h + edge.h))
      
      this.shadow.ctx.fill()
    }
  }

  checkVideoSize(checkPosition = true) {
    if (this.sizesInvalidated) {
      this.sizesInvalidated = false
      return this.updateSizes()
    }

    //Resized
    if (this.previousEnabled !== this.enabled) {
      this.previousEnabled = this.enabled
      return this.updateSizes()
    }

    //Auto quality moved up or down
    if (this.srcVideoOffset.width !== this.videoElem.videoWidth
      || this.srcVideoOffset.height !== this.videoElem.videoHeight) {
      return this.updateSizes()
    }

    if (this.videoOverlayEnabled && this.videoOverlay && this.videoElem.getAttribute('style') !== this.videoOverlay.elem.getAttribute('style')) {
      return this.updateSizes()
    }
    
    const noClipOrScale = (this.horizontalBarsClipPercentage == 0 && this.videoScale == 100)
    if(!noClipOrScale) {
      const videoElemParentElem = this.videoElem.parentElement
      if(videoElemParentElem) {
        const videoTransform = videoElemParentElem.style.getPropertyValue('--video-transform')
        const top = Math.max(0, parseInt(this.videoElem.style.top))
        const scaleY = (Math.round(1000 * (1 / this.horizontalBarsClipScaleY)) / 1000)
        if(
          videoTransform.indexOf(`translateY(${-top}px)`) === -1 ||
          videoTransform.indexOf(`scaleY(${scaleY})`) === -1
        ) {
          return this.updateSizes()
        }
      }
    }

    if(checkPosition) {
      const projectorsElemRect = this.getElemRect(this.projectorsElem)
      const videoElemRect = this.getElemRect(this.videoElem)
      const expectedProjectsElemRectY = videoElemRect.top + (videoElemRect.height * (this.horizontalBarsClipPercentage/100))
      if (
        Math.abs(projectorsElemRect.width - videoElemRect.width) > 1 ||
        Math.abs(projectorsElemRect.left - videoElemRect.left) > 1 ||
        Math.abs(projectorsElemRect.top - expectedProjectsElemRectY) > 2
      ) {
        return this.updateSizes()
      }
    }

    return true
  }

  getElemRect(elem) {
    const scrollableRect = (this.isFullscreen) ? this.ytdWatchFlexyElem.getBoundingClientRect() : body.getBoundingClientRect()
    const elemRect = elem.getBoundingClientRect()
    return {
      top: elemRect.top - scrollableRect.top,
      left: elemRect.left - scrollableRect.left,
      width: elemRect.width,
      height: elemRect.height
    }
  }

  scheduleNextFrame() {
    if (
      !this.canScheduleNextFrame() ||
      this.scheduledNextFrame
    ) return

    this.scheduleRequestVideoFrame()
    this.scheduledNextFrame = true
    raf(this.onNextFrame)
  }

  onNextFrame = () => {
    if (!this.scheduledNextFrame) return

    this.scheduledNextFrame = false
    if(this.videoElem.ended) return

    if(this.framerateLimit) {
      this.onNextLimitedFrame()
    } else {
      this.nextFrame()
      this.nextFrameTime = undefined
    }

    this.detectDisplayFrameRate()
    this.detectAmbilightFrameRate()
    this.detectVideoFrameRate()
    // this.detectVideoIsDroppingFrames()
  }

  onNextLimitedFrame = () => {
    const time = performance.now()
    if(this.nextFrameTime > time) {
      this.scheduleNextFrame()
      return
    }

    const ambilightFrameCount = this.ambilightFrameCount
    this.nextFrame()
    if(
      this.ambilightFrameCount <= ambilightFrameCount
    ) {
      return
    }

    this.nextFrameTime = Math.max((this.nextFrameTime || time) + (1000 / this.framerateLimit), time)
  }

  canScheduleNextFrame = () => (!(
    !this.enabled ||
    !this.isOnVideoPage ||
    this.videoElem.ended ||
    this.videoElem.paused ||
    this.videoElem.seeking ||
    // this.isBuffering || // Delays requestVideoFrameCallback when going to a unloaded timestamp
    this.isAmbilightHiddenOnWatchPage
  ))

  optionalFrame = () => {
    if(
      !this.enabled ||
      !this.isOnVideoPage ||
      this.isAmbilightHiddenOnWatchPage ||
      this.videoElem.ended ||
      ((!this.videoElem.paused && !this.videoElem.seeking) && this.scheduledNextFrame)
    ) return
    
    this.nextFrame()
  }

  nextFrame = () => {
    this.delayedCheckVideoSizeAndPosition = false
    if (!this.p) {
      if(!this.checkVideoSize()) {
        //If was detected hidden by checkVideoSize => updateSizes this.p won't be initialized yet
        return
      }
    } else if(this.sizesInvalidated) {
      this.checkVideoSize(false)
    } else {
      this.delayedCheckVideoSizeAndPosition = true
    }
    
    let tasks = {}
    try {
      tasks = this.drawAmbilight() || {}
    } catch (ex) {
      if(ex.name == 'NS_ERROR_NOT_AVAILABLE') {
        if(!this.catchedNS_ERROR_NOT_AVAILABLE) {
          this.catchedNS_ERROR_NOT_AVAILABLE = true
          throw ex
        }
      } else if(ex.name == 'NS_ERROR_OUT_OF_MEMORY') {
        if(!this.catchedNS_ERROR_OUT_OF_MEMORY) {
          this.catchedNS_ERROR_OUT_OF_MEMORY = true
          throw ex
        }
      } else {
        throw ex
      }
    }

    if(this.canScheduleNextFrame() && !this.isBuffering) {
      this.scheduleNextFrame()
    }

    if (tasks.detectHorizontalBarSize) {
      this.scheduleHorizontalBarSizeDetection()
    }

    if(this.afterNextFrameIdleCallback) return
    this.afterNextFrameIdleCallback = requestIdleCallback(this.afterNextFrame, { timeout: 1000/30 })
  }

  afterNextFrame = () => {
    try {
      this.afterNextFrameIdleCallback = undefined

      if (this.videoOverlayEnabled) {
        this.checkIfNeedToHideVideoOverlay()
      }
      
      if (
        this.delayedCheckVideoSizeAndPosition &&
        (performance.now() - this.lastCheckVideoSizeTime) > 2000
      ) {
        this.checkVideoSize(true)
        this.lastCheckVideoSizeTime = performance.now()
      } else if((performance.now() - this.lastUpdateStatsTime) > 2000) {
        this.updateStats()
        this.lastUpdateStatsTime = performance.now()
      }

      this.afterDrawAmbilightTasks = {}
    } catch (ex) {
      // Prevent recursive error reporting
      if(this.scheduledNextFrame) {
        cancelAnimationFrame(this.scheduledNextFrame)
        this.scheduledNextFrame = undefined
      }

      throw ex
    }
  }

  isNewFrame(oldLines, newLines) {
    if (!oldLines || oldLines.length !== newLines.length) {
      return true
    }

    for (let i = 0; i < oldLines.length; i++) {
      for (let xi = 0; xi < oldLines[i].length; xi+=10) {
        if (oldLines[i][xi] !== newLines[i][xi]) {
          return true
        }
      }
    }

    return false
  }

  detectVideoFrameRate() {
    if (this.videoFrameRateStartTime === undefined) {
      this.videoFrameRateStartTime = 0
      this.videoFrameRateStartCount = 0
    }

    const videoFrameRateTime = performance.now()
    if (this.videoFrameRateStartTime + 2000 < videoFrameRateTime) {
      const videoFrameRateCount = this.getVideoFrameCount() + this.getVideoDroppedFrameCount()
      if (this.videoFrameRateStartCount !== 0) {
        this.videoFrameRate = Math.max(0,
          (
            (videoFrameRateCount - this.videoFrameRateStartCount) / 
            ((videoFrameRateTime - this.videoFrameRateStartTime) / 1000)
          )
        )
      }
      this.videoFrameRateStartCount = videoFrameRateCount
      this.videoFrameRateStartTime = videoFrameRateTime
    }
  }

  detectDisplayFrameRate = () => {
    const displayFrameRateTime = performance.now()
    if (this.displayFrameRateStartTime < displayFrameRateTime - 2000) {
      this.displayFrameRate = Math.max(0, 
        (
          this.displayFrameRateFrame / 
          ((displayFrameRateTime - this.displayFrameRateStartTime) / 1000)
        )
      )
      this.displayFrameRateFrame = 1
      this.displayFrameRateStartTime = displayFrameRateTime
    } else {
      if (!this.displayFrameRateFrame) {
        this.displayFrameRateFrame = 1
        this.displayFrameRateStartTime = displayFrameRateTime
      } else {
        this.displayFrameRateFrame++
      }
    }
  }

  detectAmbilightFrameRate() {
    if (this.ambilightFrameRateStartTime === undefined) {
      this.ambilightFrameRateStartTime = 0
      this.ambilightFrameRateStartCount = 0
    }

    const time = performance.now()
    if (this.ambilightFrameRateStartTime + 2000 < time) {
      const count = this.ambilightFrameCount
      if (this.ambilightFrameRateStartCount !== 0) {
        this.ambilightFrameRate = Math.max(0, 
          (
            (count - this.ambilightFrameRateStartCount) / 
            ((time - this.ambilightFrameRateStartTime) / 1000)
          )
        )
      }
      this.ambilightFrameRateStartCount = count
      this.ambilightFrameRateStartTime = time
    }
  }

  getVideoDroppedFrameCount() {
    if (!this.videoElem) return 0

    // Firefox
    if(this.videoElem.mozDecodedFrames) {
      let mozDroppedFrames = Math.max(0, (this.videoElem.mozPresentedFrames - this.videoElem.mozPaintedFrames))

      // We need a cache becuase mozPresentedFrames is sometimes updated before mozPaintedFrames
      const cache = this.videoMozDroppedFramesCache || []
      cache.push(mozDroppedFrames)
      if (cache.length > 30) cache.splice(0, 1)
      this.videoMozDroppedFramesCache = cache
      mozDroppedFrames = [...cache].sort((a, b) => a - b)[0]

      return mozDroppedFrames
    }

    return (
      this.videoElem.webkitDroppedFrameCount || // Chrome
      0
    )
  }

  getVideoFrameCount() {
    if (!this.videoElem) return 0
    return (
      this.videoElem.mozPaintedFrames || // Firefox
      (this.videoElem.webkitDecodedFrameCount - this.videoElem.webkitDroppedFrameCount) || // Chrome
      0
    )
  }

  hideStats() {
    this.videoFPSElem.textContent = ''
    this.videoDroppedFramesElem.textContent = ''
    this.videoSyncedElem.textContent = ''
    this.ambilightFPSElem.textContent = ''
    this.ambilightDroppedFramesElem.textContent = ''
    this.displayFPSElem.textContent = ''
  }

  updateStats() {
    if (!this.showFPS || this.isHidden) return;

    // Video FPS
    this.videoFPSElem.textContent = `VIDEO: ${this.videoFrameRate.toFixed(2)}`

    // Video dropped frames
    const videoDroppedFrameCount = this.getVideoDroppedFrameCount()
    this.videoDroppedFramesElem.textContent = `VIDEO DROPPED: ${videoDroppedFrameCount}`
    this.videoDroppedFramesElem.style.color = (videoDroppedFrameCount > 0) ? '#ff3' : '#7f7'

    // Video synced
    if (this.videoOverlayEnabled) {
      this.videoSyncedElem.textContent = `VIDEO SYNCED: ${this.videoOverlay.isHidden ? 'NO' : 'YES'}`
      this.videoSyncedElem.style.color = this.videoOverlay.isHidden ? '#f55' : '#7f7'
      this.detectVideoSyncedWasHidden = this.videoOverlay.isHidden
    } else {
      this.videoSyncedElem.textContent = ''
    }

    // Ambilight FPS
    this.ambilightFPSElem.textContent = `AMBILIGHT: ${this.ambilightFrameRate.toFixed(2)}`
    this.ambilightFPSElem.style.color = (this.ambilightFrameRate < this.videoFrameRate * .9)
      ? '#f55'
      : (this.ambilightFrameRate < this.videoFrameRate - 0.01) ? '#ff3' : '#7f7'

    // Ambilight dropped frames
    this.ambilightDroppedFramesElem.textContent = `AMBILIGHT DROPPED: ${this.ambilightVideoDroppedFrameCount}`
    this.ambilightDroppedFramesElem.style.color = (this.ambilightVideoDroppedFrameCount > 0) ? '#ff3' : '#7f7'
    
    // Display FPS
    this.displayFPSElem.textContent = `DISPLAY: ${this.displayFrameRate.toFixed(2)}`
    this.displayFPSElem.style.color = (this.displayFrameRate < this.videoFrameRate - 1)
      ? '#f55'
      : (this.displayFrameRate < this.videoFrameRate - 0.01) ? '#ff3' : '#7f7'
  }

  drawProjectorBuffer() {
    this.blurBuffer.ctx.clearRect(0, 0, this.blurBuffer.elem.width, this.blurBuffer.elem.height)
    this.blurBuffer.ctx.drawImage(this.videoSnapshotBuffer.elem,
      0,
      this.videoSnapshotBufferBarsClipPx,
      this.videoSnapshotBuffer.elem.width,
      (this.videoSnapshotBuffer.elem.height - (this.videoSnapshotBufferBarsClipPx * 2)),

      this.filterBlurPx * 2,
      this.filterBlurPx * 2,
      this.blurBuffer.elem.width - this.filterBlurPx * 4,
      this.blurBuffer.elem.height - this.filterBlurPx * 4
    )

    this.projectorBlurBuffer.ctx.clearRect(0, 0, this.projectorBlurBuffer.elem.width, this.projectorBlurBuffer.elem.height)
    for(let i = this.spreadLevels - 1; i >= 0; i--) {
      const pos = i - this.innerStrength
      let scaleX = 1
      let scaleY = 1

      if (pos > 0) {
        scaleX = 1 + ((this.scaleStep * this.ratio.x) * pos)
        scaleY = 1 + ((this.scaleStep * this.ratio.y) * pos)
      }

      if (pos < 0) {
        scaleX = 1 - ((this.scaleStep * this.ratio.x) * -pos)
        scaleY = 1 - ((this.scaleStep * this.ratio.y) * -pos)
        if (scaleX < 0) scaleX = 0
        if (scaleY < 0) scaleY = 0
      }
      
      scaleX = Math.max(this.projectorOuterScaleMin.x, scaleX)
      scaleY = Math.max(this.projectorOuterScaleMin.y, scaleY)
      // projector.elem.style.transform = `scale(${scaleX}, ${scaleY})`
      
      const canvasScaleX = scaleX // * (this.projectorOuterScale.x / this.projectorScale.x)
      const canvasScaleY = scaleY // * (this.projectorOuterScale.y / this.projectorScale.y)

      // console.log('draw', pos, canvasScaleX, canvasScaleY)

      const width = this.blurBuffer.elem.width + this.filterBlurPx * 2
      const height = this.blurBuffer.elem.height + this.filterBlurPx * 2

      this.projectorBlurBuffer.ctx.drawImage(this.blurBuffer.elem,
        0,
        0,
        this.blurBuffer.elem.width,
        this.blurBuffer.elem.height,
        
        ((this.projectorBlurBuffer.elem.width - (width * canvasScaleX)) / 2),
        ((this.projectorBlurBuffer.elem.height - (height * canvasScaleY)) / 2),
        (width * canvasScaleX),
        (height * canvasScaleY)
      )
    }

    this.projectorBuffer.ctx.clearRect(0, 0, this.projectorBuffer.elem.width, this.projectorBuffer.elem.height)
    this.projectorBuffer.ctx.drawImage(this.projectorBlurBuffer.elem, 0, 0)
  }

  drawAmbilight() {
    if (!this.enabled || !this.isOnVideoPage) return

    if (
      this.isVR ||
      (this.isFillingFullscreen && !this.detectHorizontalBarSizeEnabled && !this.frameBlending && !this.videoOverlayEnabled) ||
      (!this.enableInFullscreen && this.isFullscreen)
    ) {
      this.hide()
      return
    }

    const drawTime = performance.now()
    if (this.isHidden) {
      this.show()
    }

    if (
      this.isVideoHiddenOnWatchPage || 
      this.isAmbilightHiddenOnWatchPage ||
      this.videoElem.ended || 
      this.videoElem.readyState === 0 || // HAVE_NOTHING
      this.videoElem.readyState === 1    // HAVE_METADATA
    ) return

    //performance.mark('start-drawing')
    let newVideoFrameCount = this.getVideoFrameCount()

    let updateVideoSnapshot = this.buffersCleared
    if(!updateVideoSnapshot) {
      if (this.frameSync == 150) { // PERFECT
        if(this.videoIsHidden) {
          updateVideoSnapshot = true // Force video.webkitDecodedFrameCount to update on Chromium by always executing drawImage
        } else {
          updateVideoSnapshot = this.buffersCleared || this.videoFrameCallbackReceived
          this.videoFrameCallbackReceived = false
        }
      } else if(this.frameSync == 0) { // PERFORMANCE
        updateVideoSnapshot = this.buffersCleared || (this.videoFrameCount < newVideoFrameCount)
      } else if (this.frameSync == 50) { // BALANCED
        updateVideoSnapshot = true
      } else if (this.frameSync == 100) { // HIGH PRECISION
        updateVideoSnapshot = true
      }
    }

    if(updateVideoSnapshot) {
      this.videoSnapshotBuffer.ctx.drawImage(this.videoElem, 
        0, 0, this.videoSnapshotBuffer.elem.width, this.videoSnapshotBuffer.elem.height)
    }

    let hasNewFrame = this.buffersCleared
    if(this.frameSync == 150) { // PERFECT
      newVideoFrameCount = this.getVideoFrameCount()
      hasNewFrame = hasNewFrame || (this.videoFrameCount < newVideoFrameCount) || (
        this.videoVisibilityChangeTime > drawTime - 3000 &&
        this.previousFrameTime < (drawTime - (1000 / 25))
      ) 
    } else if(this.frameSync == 0) { // PERFORMANCE
      hasNewFrame = hasNewFrame || updateVideoSnapshot
    } else if (this.frameSync == 50 || this.frameBlending) { // BALANCED
      hasNewFrame = hasNewFrame || (this.videoFrameCount < newVideoFrameCount)
      
      if (this.videoFrameRate && this.displayFrameRate && this.displayFrameRate > this.videoFrameRate) {
        if(!hasNewFrame || this.framerateLimit > this.videoFrameRate - 1) {
          if(
            (this.getImageDataAllowed && this.checkGetImageDataAllowed(true)) ||
            this.getImageDataAllowed
          ) {
            // Execute getImageData on a separate buffer for performance:
            // 1. We don't interrupt the video to ambilight canvas flow (144hz instead of 85hz)
            // 2. We don't keep getting penalized after horizontal bar detection is disabled  (144hz instead of 45hz)
            const getImageDataBuffer = this.videoSnapshotGetImageDataBuffer
            getImageDataBuffer.ctx.drawImage(this.videoSnapshotBuffer.elem, 0, 0)

            let lines = []
            let partSize = Math.ceil(getImageDataBuffer.elem.height / 3)
            try {
              for (let i = partSize; i < getImageDataBuffer.elem.height; i += partSize) {
                lines.push(getImageDataBuffer.ctx.getImageData(0, i, getImageDataBuffer.elem.width, 1).data)
              }
            } catch (ex) {
              if (!this.showedCompareWarning) {
                this.showedCompareWarning = true
                throw ex
              }
            }

            if (!hasNewFrame) {
              const isConfirmedNewFrame = this.isNewFrame(this.oldLines, lines)
              if (isConfirmedNewFrame) {
                newVideoFrameCount++
                hasNewFrame = true
              }
            }
            //performance.mark('comparing-compare-end')

            if (hasNewFrame) {
              if(this.oldLines) {
                this.oldLines.length = 0 // Free memory
              }
              this.oldLines = lines
            }
          }
        }
      }
    } else if (this.frameSync == 100) { // HIGH PRECISION
      hasNewFrame = true
    }
    
    const droppedFrames = (this.videoFrameCount > 120 && this.videoFrameCount < newVideoFrameCount - 1)
    if (droppedFrames && !this.buffersCleared) {
      this.ambilightVideoDroppedFrameCount += newVideoFrameCount - (this.videoFrameCount + 1)
    }
    if (newVideoFrameCount > this.videoFrameCount || newVideoFrameCount < this.videoFrameCount - 60) {
      this.videoFrameCount = newVideoFrameCount
    }

    if (this.frameBlending && this.frameBlendingSmoothness) {
      if (!this.previousProjectorBuffer) {
        this.initFrameBlending()
      }
      if (this.videoOverlayEnabled && !this.previousVideoOverlayBuffer) {
        this.initVideoOverlayWithFrameBlending()
      }

      // Prevent unnessecary frames drawing when frameBlending is not 100% but keep counting becuase we calculate with this.ambilightFrameRate
      if(hasNewFrame || this.buffersCleared || !this.previousDrawFullAlpha) {

        if (hasNewFrame || this.buffersCleared) {
          if (this.videoOverlayEnabled) {
            this.previousVideoOverlayBuffer.ctx.drawImage(this.videoOverlayBuffer.elem, 0, 0)
            this.videoOverlayBuffer.ctx.drawImage(this.videoElem, 
              0, 0, this.videoOverlayBuffer.elem.width, this.videoOverlayBuffer.elem.height)
            if(this.buffersCleared) {
              this.previousVideoOverlayBuffer.ctx.drawImage(this.videoOverlayBuffer.elem, 0, 0)
            }
          }
          if(!this.buffersCleared) {
            this.previousProjectorBuffer.ctx.clearRect(0, 0, this.previousProjectorBuffer.elem.width, this.previousProjectorBuffer.elem.height)
            this.previousProjectorBuffer.ctx.drawImage(this.projectorBuffer.elem, 0, 0)
          }
          // Prevent adjusted videoSnapshotBufferBarsClipPx from leaking previous frame into the frame
          this.drawProjectorBuffer()
          if(this.buffersCleared) {
            this.previousProjectorBuffer.ctx.clearRect(0, 0, this.previousProjectorBuffer.elem.width, this.previousProjectorBuffer.elem.height)
            this.previousProjectorBuffer.ctx.drawImage(this.projectorBuffer.elem, 0, 0)
          }
        }

        let alpha =  1
        const ambilightFrameDuration = 1000 / this.ambilightFrameRate
        if(hasNewFrame) {
          this.frameBlendingFrameTimeStart = drawTime - (ambilightFrameDuration / 2)
        }
        if(this.displayFrameRate >= this.videoFrameRate * 1.33) {
          if(hasNewFrame && !this.previousDrawFullAlpha) {
            alpha = 0 // Show previous frame fully to prevent seams
          } else {
            const videoFrameDuration = 1000 / this.videoFrameRate
            const frameToDrawDuration = drawTime - this.frameBlendingFrameTimeStart
            const frameToDrawDurationThresshold = (frameToDrawDuration + (ambilightFrameDuration / 2)) / (this.frameBlendingSmoothness / 100)
            // console.log(frameToDrawDurationThresshold, frameToDrawDuration, ambilightFrameDuration, videoFrameDuration)
            if (frameToDrawDurationThresshold < videoFrameDuration) {
              alpha = Math.min(1, (
                frameToDrawDuration / (
                  1000 / (
                    this.videoFrameRate / 
                    (this.frameBlendingSmoothness / 100) || 1
                  )
                )
              ))
            }
          }
        }
        if(alpha === 1) {
          this.previousDrawFullAlpha = true
        } else {
          this.previousDrawFullAlpha = false
        }
        // console.log(hasNewFrame, this.buffersCleared, alpha)

        if (this.videoOverlayEnabled && this.videoOverlay && !this.videoOverlay.isHidden) {
          if(alpha !== 1) {
            if(this.videoOverlay.ctx.globalAlpha !== 1) {
              this.videoOverlay.ctx.globalAlpha = 1
            }
            this.videoOverlay.ctx.drawImage(this.previousVideoOverlayBuffer.elem, 0, 0)
          }
          if(alpha > 0.005) {
            this.videoOverlay.ctx.globalAlpha = alpha
            this.videoOverlay.ctx.drawImage(this.videoOverlayBuffer.elem, 0, 0)
          }
          this.videoOverlay.ctx.globalAlpha = 1
        }

        //this.blendedProjectorBuffer can contain an old frame and be impossible to drawImage onto
        //this.previousProjectorBuffer can also contain an old frame
        
        this.blendedProjectorBuffer.ctx.clearRect(0, 0, this.blendedProjectorBuffer.elem.width, this.blendedProjectorBuffer.elem.height)
        if(alpha !== 1) {
          if(this.blendedProjectorBuffer.ctx.globalAlpha !== 1)
            this.blendedProjectorBuffer.ctx.globalAlpha = 1
          this.blendedProjectorBuffer.ctx.drawImage(this.previousProjectorBuffer.elem, 0, 0)
        }
        if(alpha > 0.005) {
          this.blendedProjectorBuffer.ctx.globalAlpha = alpha
          this.blendedProjectorBuffer.ctx.drawImage(this.projectorBuffer.elem, 0, 0)
        }
        this.blendedProjectorBuffer.ctx.globalAlpha = 1

        this.projector.ctx.clearRect(0, 0, this.projector.elem.width, this.projector.elem.height)
        this.projector.ctx.drawImage(this.blendedProjectorBuffer.elem, 0, 0)
      }
    } else {
      if (!hasNewFrame) return

      if (this.videoOverlayEnabled && this.videoOverlay && !this.videoOverlay.isHidden) {
        if(this.enableChromiumBug1092080Workaround) { // && this.displayFrameRate >= this.ambilightFrameRate) {
          this.videoOverlay.ctx.clearRect(0, 0, this.videoOverlay.elem.width, this.videoOverlay.elem.height)
        }
        this.videoOverlay.ctx.drawImage(this.videoElem, 
          0, 0, this.videoOverlay.elem.width, this.videoOverlay.elem.height)
      }

      // Prevent adjusted videoSnapshotBufferBarsClipPx from leaking previous frame into the frame
      this.drawProjectorBuffer()

      // if(this.enableChromiumBug1092080Workaround) { // && this.displayFrameRate >= this.ambilightFrameRate) {
      //   for(const projector of this.projectors) {
      //     projector.ctx.clearRect(0, 0, projector.elem.width, projector.elem.height)
      //   }
      // }
      this.projector.ctx.clearRect(0, 0, this.projector.elem.width, this.projector.elem.height)
      this.projector.ctx.drawImage(this.projectorBuffer.elem, 0, 0)
    }

    this.buffersCleared = false
    this.ambilightFrameCount++
    this.previousDrawTime = drawTime
    if(hasNewFrame) {
      this.previousFrameTime = drawTime
    }

    if(this.enableMozillaBug1606251Workaround) {
      this.elem.style.transform = `translateZ(${this.ambilightFrameCount % 10}px)`;
    }

    // Horizontal bar detection
    if(
      this.detectHorizontalBarSizeEnabled &&
      hasNewFrame
    ) {
      return { detectHorizontalBarSize: true }
    }
  }

  scheduleHorizontalBarSizeDetection = () => {
    try {
      if(!this.horizontalBarDetection) {
        this.horizontalBarDetection = new HorizontalBarDetection()
      } else if(this.horizontalBarDetection.busy) {
        return
      }

      if(
        (this.getImageDataAllowed && this.checkGetImageDataAllowed(true)) || 
        this.getImageDataAllowed
      ) {
        this.horizontalBarDetection.detect(
          this.videoSnapshotBuffer,
          this.detectColoredHorizontalBarSizeEnabled,
          this.detectHorizontalBarSizeOffsetPercentage,
          this.horizontalBarsClipPercentage,
          wrapErrorHandler(this.scheduleHorizontalBarSizeDetectionCallback)
        )
      }
    } catch (ex) {
      if (!this.showedDetectHorizontalBarSizeWarning) {
        this.showedDetectHorizontalBarSizeWarning = true
        throw ex
      }
    }
  }

  scheduleHorizontalBarSizeDetectionCallback = (percentage) => {
    if(percentage !== undefined)
      this.setHorizontalBars(percentage)
  }

  checkIfNeedToHideVideoOverlay() {
    if(!this.videoOverlay) return

    if(!this.hideVideoOverlayCache) {
      this.hideVideoOverlayCache = {
        prevAmbilightVideoDroppedFrameCount: this.ambilightVideoDroppedFrameCount,
        framesInfo: [],
        isHiddenChangeTimestamp: 0
      }
    }

    let {
      prevAmbilightVideoDroppedFrameCount,
      framesInfo,
      isHiddenChangeTimestamp
    } = this.hideVideoOverlayCache

    const newFramesDropped = Math.max(0, this.ambilightVideoDroppedFrameCount - prevAmbilightVideoDroppedFrameCount)
    this.hideVideoOverlayCache.prevAmbilightVideoDroppedFrameCount = this.ambilightVideoDroppedFrameCount
    framesInfo.push({
      time: performance.now(),
      framesDropped: newFramesDropped
    })
    const frameDropTimeLimit = performance.now() - 2000
    framesInfo = framesInfo.filter(info => info.time > frameDropTimeLimit)
    this.hideVideoOverlayCache.framesInfo = framesInfo

    let hide = this.isBuffering || this.videoElem.paused || this.videoElem.seeking || this.videoIsHidden
    if(!hide && this.videoOverlaySyncThreshold !== 100) {
      if(
        framesInfo.length < 5
      ) {
        hide = true
      } else {
        const droppedFramesCount = framesInfo.reduce((sum, info) => sum + info.framesDropped, 0)
        const droppedFramesThreshold = (this.videoFrameRate * 2) * (this.videoOverlaySyncThreshold / 100)
        hide = droppedFramesCount > droppedFramesThreshold
      }
    }

    if (hide) {
      if (!this.videoOverlay.isHidden) {
        this.videoOverlay.elem.classList.add('ambilight__video-overlay--hide')
        this.videoOverlay.isHidden = true
        this.hideVideoOverlayCache.isHiddenChangeTimestamp = performance.now()
        this.updateStats()
      }
    } else if (
      this.videoOverlaySyncThreshold == 100 ||
      isHiddenChangeTimestamp + 2000 < performance.now()
    ) {
      if (this.videoOverlay.isHidden) {
        this.videoOverlay.elem.classList.remove('ambilight__video-overlay--hide')
        this.videoOverlay.isHidden = false
        this.hideVideoOverlayCache.isHiddenChangeTimestamp = performance.now()
        this.updateStats()
      }
    }
  }

  enable(initial = false) {
    if (this.enabled && !initial) return

    this.setSetting('enabled', true)
    const enabledInput = $.s(`#setting-enabled`)
    if(enabledInput) enabledInput.setAttribute('aria-checked', true)

    this.updateView()
    if (!this.enableInFullscreen && this.view === this.VIEW_FULLSCREEN) return

    html.setAttribute('data-ambilight-enabled', true)
    this.videoPlayerElem.setSize()

    if (!initial) {
      const toLight = !html.getAttribute('dark')
      this.resetThemeToLightOnDisable = toLight
      this.setSetting('resetThemeToLightOnDisable', toLight)
      const resetInput = $.s(`#setting-resetThemeToLightOnDisable`)
      if(resetInput) resetInput.setAttribute('aria-checked', toLight)
    }

    this.start()
  }

  disable() {
    if (!this.enabled) return

    this.setSetting('enabled', false)
    const enabledInput = $.s(`#setting-enabled`)
    if(enabledInput) enabledInput.setAttribute('aria-checked', false)
    html.setAttribute('data-ambilight-enabled', false)
    this.videoPlayerElem.setSize()

    if (this.resetThemeToLightOnDisable) {
      this.resetThemeToLightOnDisable = undefined
      Ambilight.setDarkTheme(false)
    }

    this.videoElem.style.marginTop = ''
    const videoElemParentElem = this.videoElem.parentNode
    if (videoElemParentElem) {
      videoElemParentElem.style.overflow = ''
      videoElemParentElem.style.marginTop = ''
      videoElemParentElem.style.height = ''
      videoElemParentElem.style.marginBottom = ''
    }

    this.checkVideoSize()
    this.hide()
  }

  static setDarkTheme(value) {
    try {
      if (Ambilight.isClassic) return
      if (Ambilight.setDarkThemeBusy) return
      if (html.getAttribute('dark')) {
        if (value) return
      } else {
        if (!value) return
      }
      if (value && !$.s('ytd-app').hasAttribute('is-watch-page')) return
      Ambilight.setDarkThemeBusy = true

      const toggle = (rendererElem) => {
        rendererElem = rendererElem || $.s('ytd-toggle-theme-compact-link-renderer')
        if (value) {
          rendererElem.handleSignalActionToggleDarkThemeOn()
        } else {
          rendererElem.handleSignalActionToggleDarkThemeOff()
        }
        Ambilight.setDarkThemeBusy = false
      }

      const rendererElem = $.s('ytd-toggle-theme-compact-link-renderer')
      if (rendererElem) {
        toggle(rendererElem)
      } else {
        const findBtn = () => $.s('#avatar-btn') || // When logged in
          $.s('.ytd-masthead#buttons ytd-topbar-menu-button-renderer:last-of-type') // When not logged in

        $.s('ytd-popup-container').style.opacity = 0
        waitForDomElement(
          findBtn,
          'ytd-masthead',
          () => {
            waitForDomElement(
              () => {
                const rendererElem = $.s('ytd-toggle-theme-compact-link-renderer')
                return (rendererElem && rendererElem.handleSignalActionToggleDarkThemeOn)
              },
              'ytd-popup-container',
              () => {
                findBtn().click()
                toggle()
                setTimeout(() => {
                  $.s('ytd-popup-container').style.opacity = ''
                  previousActiveElement.focus()
                }, 1)
              })
            let previousActiveElement = document.activeElement
            findBtn().click()
          }
        )
      }
    } catch (ex) {
      console.error('YouTube Ambilight | Error while setting dark mode', ex)
      AmbilightSentry.captureExceptionWithDetails(ex)
      Ambilight.setDarkThemeBusy = false
    }
  }

  toggleEnabled() {
    if (this.enabled)
      this.disable()
    else
      this.enable()
  }

  start() {
    if (!this.isOnVideoPage || !this.enabled) return

    this.videoFrameRateMeasureStartFrame = 0
    this.videoFrameRateMeasureStartTime = 0
    this.ambilightVideoDroppedFrameCount = 0

    this.showedCompareWarning = false
    this.showedDetectHorizontalBarSizeWarning = false

    this.requestVideoFrameCallbackId = undefined
    this.nextFrameTime = undefined

    this.sizesInvalidated = true // Prevent wrong size from being used
    this.buffersCleared = true // Prevent old frame from preventing the new frame from being drawn
    this.checkGetImageDataAllowed()
    this.resetSettingsIfNeeded()

    // Prevent incorrect stats from showing
    this.lastUpdateStatsTime = performance.now() + 2000

    if (!html.getAttribute('dark')) {
      Ambilight.setDarkTheme(true)
    }

    this.nextFrame()
  }

  scheduleRequestVideoFrame = () => {
    if (
      !this.canScheduleNextFrame() ||
      
      // this.videoFrameCallbackReceived || // Doesn't matter because this can be true now but not when the new video frame is received
      this.requestVideoFrameCallbackId ||
      this.frameSync != 150 ||

      this.videoIsHidden // Partial solution for https://bugs.chromium.org/p/chromium/issues/detail?id=1142112#c9
    ) return

    this.requestVideoFrameCallbackId = this.videoElem.requestVideoFrameCallback(this.receiveVideoFrame)
  }

  receiveVideoFrame = () => {
    this.requestVideoFrameCallbackId = undefined
    this.videoFrameCallbackReceived = true

    // Chromium issue: <todo>
    //
    // Call requestVideoFrameCallback immediately because the next callback sometimes 
    // misses the next video frame when the video framerate matches the display framerate
    // and requestVideoFrameCallback is called after drawing the ambilight canvas.
    // Calling requestVideoFrameCallback immediately makes sure we always get the next 
    // video frame as long as drawAmbilight is finished before the next video frame is presented.
    this.videoElem.requestVideoFrameCallback(() => {})
  }

  hide() {
    if (this.isHidden) return
    this.isHidden = true

    this.elem.style.opacity = 0.0000001; //Avoid memory leak https://codepen.io/wesselkroos/pen/MWWorLW
    if (this.videoOverlay && this.videoOverlay.elem.parentNode) {
      this.videoOverlay.elem.parentNode.removeChild(this.videoOverlay.elem)
    }
    this.resetVideoContainerStyle()
    this.clear()
    this.hideStats()

    html.setAttribute('data-ambilight-enabled', false)
    html.setAttribute('data-ambilight-classic', false)
    if(Ambilight.isClassic) {
      html.setAttribute('dark', false)
    }
    if (this.resetThemeToLightOnDisable) {
      Ambilight.setDarkTheme(false)
    }
  }

  show() {
    this.isHidden = false
    this.elem.style.opacity = 1
    Ambilight.setDarkTheme(true)
    html.setAttribute('data-ambilight-enabled', true)
    html.setAttribute('data-ambilight-classic', Ambilight.isClassic)
    if(Ambilight.isClassic) {
      html.setAttribute('dark', true)
    }
  }

  checkScrollPosition = () => {
    const immersive = (this.immersive || (this.immersiveTheaterView && this.view === this.VIEW_THEATER))

    if (this.atTop && immersive) {
      this.ytdWatchFlexyElem.classList.add('at-top')
    } else {
      this.ytdWatchFlexyElem.classList.remove('at-top')
    }

    if (this.atTop) {
      this.mastheadElem.classList.add('at-top')
    } else {
      this.mastheadElem.classList.remove('at-top')
    }
  }

  updateImmersiveMode() {
    this.updateView()
    const immersiveMode = (this.immersive || (this.immersiveTheaterView && this.view === this.VIEW_THEATER))
    const changed = (html.getAttribute('data-ambilight-immersive-mode') !== immersiveMode.toString())
    html.setAttribute('data-ambilight-immersive-mode', immersiveMode)
    if(!changed) return

    this.checkScrollPosition()
    this.videoPlayerElem.setSize()
  }

  toggleImmersiveMode() {
    const enabled = !this.immersive
    $.s(`#setting-immersive`).setAttribute('aria-checked', enabled ? 'true' : 'false')
    this.setSetting('immersive', enabled)

    this.updateImmersiveMode()
  }

  initSettingsMenu() {
    this.settingsMenuBtn = document.createElement('button')
    this.settingsMenuBtn.classList.add('ytp-button', 'ytp-ambilight-settings-button')
    this.settingsMenuBtn.setAttribute('title', 'Ambilight settings')
    this.settingsMenuBtn.setAttribute('aria-owns', 'ytp-id-190')
    on(this.settingsMenuBtn, 'click', this.onSettingsBtnClicked, undefined, (listener) => this.onSettingsBtnClickedListener = listener)
    this.settingsMenuBtn.innerHTML = `<svg height="100%" version="1.1" viewBox="0 0 36 36" width="100%">
      <path d="m 23.94,18.78 c .03,-0.25 .05,-0.51 .05,-0.78 0,-0.27 -0.02,-0.52 -0.05,-0.78 l 1.68,-1.32 c .15,-0.12 .19,-0.33 .09,-0.51 l -1.6,-2.76 c -0.09,-0.17 -0.31,-0.24 -0.48,-0.17 l -1.99,.8 c -0.41,-0.32 -0.86,-0.58 -1.35,-0.78 l -0.30,-2.12 c -0.02,-0.19 -0.19,-0.33 -0.39,-0.33 l -3.2,0 c -0.2,0 -0.36,.14 -0.39,.33 l -0.30,2.12 c -0.48,.2 -0.93,.47 -1.35,.78 l -1.99,-0.8 c -0.18,-0.07 -0.39,0 -0.48,.17 l -1.6,2.76 c -0.10,.17 -0.05,.39 .09,.51 l 1.68,1.32 c -0.03,.25 -0.05,.52 -0.05,.78 0,.26 .02,.52 .05,.78 l -1.68,1.32 c -0.15,.12 -0.19,.33 -0.09,.51 l 1.6,2.76 c .09,.17 .31,.24 .48,.17 l 1.99,-0.8 c .41,.32 .86,.58 1.35,.78 l .30,2.12 c .02,.19 .19,.33 .39,.33 l 3.2,0 c .2,0 .36,-0.14 .39,-0.33 l .30,-2.12 c .48,-0.2 .93,-0.47 1.35,-0.78 l 1.99,.8 c .18,.07 .39,0 .48,-0.17 l 1.6,-2.76 c .09,-0.17 .05,-0.39 -0.09,-0.51 l -1.68,-1.32 0,0 z m -5.94,2.01 c -1.54,0 -2.8,-1.25 -2.8,-2.8 0,-1.54 1.25,-2.8 2.8,-2.8 1.54,0 2.8,1.25 2.8,2.8 0,1.54 -1.25,2.8 -2.8,2.8 l 0,0 z" fill="#fff"></path>
    </svg>`
    this.settingsMenuBtnParent.prepend(this.settingsMenuBtn)

    this.settingsMenuElem = document.createElement('div')
    this.settingsMenuElem.classList.add(
      ...([
        'ytp-popup', 
        'ytp-settings-menu', 
        'ytpa-ambilight-settings-menu', 
        (this.advancedSettings) ? 'ytpa-ambilight-settings-menu--advanced' : undefined
      ].filter(c => c))
    )
    this.settingsMenuElem.setAttribute('id', 'ytp-id-190')
    this.settingsMenuElem.innerHTML = `
      <div class="ytp-panel">
        <div class="ytp-panel-menu" role="menu">
          <a class="ytpa-feedback-link" rowspan="2" href="${this.feedbackFormLink}" target="_blank">
            <span class="ytpa-feedback-link__text">Give feedback or rate YouTube Ambilight</span>
          </a>
          ${
      this.settings.map(setting => {
        let classes = 'ytp-menuitem'
        if(setting.advanced) classes += ' ytpa-menuitem--advanced'
        if(setting.new) classes += ' ytpa-menuitem--new'
        if(setting.experimental) classes += ' ytpa-menuitem--experimental'

        if (setting.type === 'checkbox') {
          return `
            <div id="setting-${setting.name}" 
            class="${classes}" 
            role="menuitemcheckbox" 
            aria-checked="${setting.value ? 'true' : 'false'}" 
            tabindex="0">
              <div class="ytp-menuitem-label">${setting.label}</div>
              <div class="ytp-menuitem-content">
                <div class="ytp-menuitem-toggle-checkbox"></div>
              </div>
            </div>
          `
        } else if (setting.type === 'list') {
          return `
            <div id="setting-${setting.name}" class="ytp-menuitem-range-wrapper">
              <div class="${classes}" aria-haspopup="false" role="menuitemrange" tabindex="0">
                <div class="ytp-menuitem-label">${setting.label}</div>
                <div id="setting-${setting.name}-value" class="ytp-menuitem-content">${this.getSettingListDisplayText(setting)}</div>
              </div>
              <div 
              class="ytp-menuitem-range ${setting.snapPoints ? 'ytp-menuitem-range--has-snap-points' : ''}" 
              rowspan="2" 
              title="Double click to reset">
                <input 
                  id="setting-${setting.name}-range" 
                  type="range" 
                  min="${setting.min}" 
                  max="${setting.max}" 
                  colspan="2" 
                  value="${setting.value}" 
                  step="${setting.step || 1}" />
              </div>
              ${!setting.snapPoints ? '' : `
                <datalist class="setting-range-datalist" id="snap-points-${setting.name}">
                  ${setting.snapPoints.map((point, i) => `
                    <option 
                      class="setting-range-datalist__label ${(point < setting.snapPoints[i - 1] + 2) ? 'setting-range-datalist__label--flip' : ''}" 
                      value="${point}" 
                      label="${Math.floor(point)}" 
                      title="Snap to ${point}" 
                      style="margin-left: ${(point + (-setting.min)) * (100 / (setting.max - setting.min))}%">
                      ${Math.floor(point)}
                    </option>
                  `).join('')}
                </datalist>
              `}
            </div>
          `
        } else if (setting.type === 'section') {
          return `
            <div 
              class="ytpa-section ${setting.value ? 'is-collapsed' : ''} ${setting.advanced ? 'ytpa-section--advanced' : ''}" 
              data-name="${setting.name}">
              <div class="ytpa-section__cell">
                <div class="ytpa-section__label">${setting.label}</div>
              </div>
              <div class="ytpa-section__cell">
                <div class="ytpa-section__fill">-</div>
              </div>
            </div>
          `
        }
      }).join('')
          }
        </div>
      </div>`
    this.settingsMenuElem.querySelectorAll('.setting-range-datalist__label').forEach(label => {
      on(label, 'click', (e) => {
        const value = e.target.value
        const name = e.target.parentNode.id.replace('snap-points-', '')
        const inputElem = $.s(`#setting-${name}-range`)
        inputElem.value = value
        inputElem.dispatchEvent(new Event('change', { bubbles: true }))
      })
    })
    this.settingsMenuElem.querySelectorAll('.ytpa-section').forEach(section => {
      on(section, 'click', (e) => {
        const name = section.getAttribute('data-name')
        const settingSection = this.settings.find(setting => setting.type == 'section' && setting.name == name)
        if (!settingSection) return
        settingSection.value = !settingSection.value
        this.setSetting(name, settingSection.value)

        if (settingSection.value) {
          section.classList.add('is-collapsed')
        } else {
          section.classList.remove('is-collapsed')
        }
      })
    })
    this.settingsMenuElemParent = this.videoPlayerElem
    this.settingsMenuElemParent.prepend(this.settingsMenuElem)
    try {
      this.settingsMenuElem.scrollTop = this.settingsMenuElem.scrollHeight
      this.settingsMenuOnCloseScrollBottom = (!this.settingsMenuElem.scrollTop) 
        ? -1 
        : (this.settingsMenuElem.scrollHeight - this.settingsMenuElem.offsetHeight) - this.settingsMenuElem.scrollTop
      this.settingsMenuOnCloseScrollHeight = (this.settingsMenuElem.scrollHeight - this.settingsMenuElem.offsetHeight)
    } catch(ex) {
      console.error('YouTube Ambilight | initSettingsMenuScrollInformation', ex)
      AmbilightSentry.captureExceptionWithDetails(ex)
    }

    this.settings.forEach(setting => {
      if (setting.type === 'list') {
        const inputElem = $.s(`#setting-${setting.name}-range`)
        const displayedValue = $.s(`#setting-${setting.name}-value`)
        on(inputElem, 'change mousemove dblclick touchmove', (e) => {
          if(e.type === 'mousemove' && e.buttons === 0) return

          let value = parseFloat(inputElem.value)
          if (e.type === 'dblclick') {
            value = this.settings.find(s => s.name === setting.name).default
          } else if (inputElem.value === inputElem.getAttribute('data-previous-value')) {
            return
          }
          inputElem.value = value
          inputElem.setAttribute('data-previous-value', value)
          this.setSetting(setting.name, value)
          displayedValue.textContent = this.getSettingListDisplayText({...setting, value})

          if(!this.advancedSettings) {
            if(setting.name === 'blur') {
              const edgeSetting = this.settings.find(setting => setting.name === 'edge')
              const edgeValue = (value <= 5 ) ? 2 : ((value >= 42.5) ? 17 : (
                value/2.5
              ))

              const edgeInputElem = $.s(`#setting-${edgeSetting.name}-range`)
              edgeInputElem.value = edgeValue
              edgeInputElem.dispatchEvent(new Event('change', { bubbles: true }))
            }
          }

          if(
            setting.name === 'horizontalBarsClipPercentage' &&
            this.detectHorizontalBarSizeEnabled
          ) {
            const controllerInput = $.s(`#setting-detectHorizontalBarSizeEnabled`)
            controllerInput.dontResetControlledSetting = true
            controllerInput.click()
          }

          if(setting.name === 'videoScale') {
            if(this.detectVideoFillScaleEnabled) {
              const controllerInput = $.s(`#setting-detectVideoFillScaleEnabled`)
              controllerInput.dontResetControlledSetting = true
              controllerInput.click()
            }
          }

          if (
            setting.name === 'surroundingContentShadowSize' ||
            setting.name === 'surroundingContentShadowOpacity' ||
            setting.name === 'surroundingContentImagesTransparency' ||
            setting.name === 'debandingStrength' ||
            setting.name === 'videoShadowSize' ||
            setting.name === 'videoShadowOpacity' ||
            setting.name === 'videoScale'
          ) {
            this.updateStyles()
          }

          if (
            this.detectHorizontalBarSizeEnabled &&
            setting.name === 'detectHorizontalBarSizeOffsetPercentage'
          ) {
            this.scheduleHorizontalBarSizeDetection()
          }

          this.buffersCleared = true
          this.sizesInvalidated = true
          this.optionalFrame()
        })
      } else if (setting.type === 'checkbox') {
        const inputElem = $.s(`#setting-${setting.name}`)
        on(inputElem, 'click', () => {
          setting.value = !setting.value

          if (setting.name === 'enabled') {
            if (setting.value)
              this.enable()
            else
              this.disable()
          }
          if (setting.name === 'immersive') {
            this.toggleImmersiveMode()
          }
          if (setting.name === 'hideScrollbar') {
            const changed = (html.getAttribute('data-ambilight-hide-scrollbar') !== setting.value.toString())
            html.setAttribute('data-ambilight-hide-scrollbar', setting.value)
            if(changed) {
              this.videoPlayerElem.setSize()
            }
          }
          if (
            setting.name === 'videoOverlayEnabled' ||
            setting.name === 'frameSync' ||
            setting.name === 'frameBlending' ||
            setting.name === 'enableInFullscreen' ||
            setting.name === 'showFPS' ||
            setting.name === 'resetThemeToLightOnDisable' ||
            setting.name === 'surroundingContentTextAndBtnOnly' ||
            setting.name === 'horizontalBarsClipPercentageReset' ||
            setting.name === 'detectHorizontalBarSizeEnabled' ||
            setting.name === 'detectColoredHorizontalBarSizeEnabled' ||
            setting.name === 'detectVideoFillScaleEnabled' ||
            setting.name === 'directionTopEnabled' ||
            setting.name === 'directionRightEnabled' ||
            setting.name === 'directionBottomEnabled' ||
            setting.name === 'directionLeftEnabled' ||
            setting.name === 'advancedSettings' ||
            setting.name === 'hideScrollbar' ||
            setting.name === 'immersiveTheaterView'
          ) {
            this.setSetting(setting.name, setting.value)
            $.s(`#setting-${setting.name}`).setAttribute('aria-checked', setting.value)
          }

          if(setting.name === 'immersiveTheaterView') {
            this.updateImmersiveMode()
          }

          if(setting.name === 'detectHorizontalBarSizeEnabled') {
            if(!setting.value) {
              if(!inputElem.dontResetControlledSetting) {
                const horizontalBarsClipPercentageSetting = this.settings.find(setting => setting.name === 'horizontalBarsClipPercentage')
                const horizontalBarsClipPercentageInputElem = $.s(`#setting-${horizontalBarsClipPercentageSetting.name}-range`)
                horizontalBarsClipPercentageInputElem.value = horizontalBarsClipPercentageSetting.default
                horizontalBarsClipPercentageInputElem.dispatchEvent(new Event('change', { bubbles: true }))
                this.setSetting('horizontalBarsClipPercentage', horizontalBarsClipPercentageSetting.default)
              }
            }
            if(inputElem.dontResetControlledSetting) {
              delete inputElem.dontResetControlledSetting
            }
            this.updateControlledSettings()
          }

          if(setting.name === 'detectVideoFillScaleEnabled') {
            if(!setting.value) {
              if(!inputElem.dontResetControlledSetting) {
                const videoScaleSetting = this.settings.find(setting => setting.name === 'videoScale')
                const videoScaleInputElem = $.s(`#setting-${videoScaleSetting.name}-range`)
                videoScaleInputElem.value = videoScaleSetting.default
                videoScaleInputElem.dispatchEvent(new Event('change', { bubbles: true }))
                this.setSetting('videoScale', videoScaleSetting.default)
              }
            }
            if(inputElem.dontResetControlledSetting) {
              delete inputElem.dontResetControlledSetting
            }
            this.updateControlledSettings()
          }

          if(setting.name === 'advancedSettings') {
            if(setting.value) {
              this.settingsMenuElem.classList.add('ytpa-ambilight-settings-menu--advanced')
            } else {
              this.settingsMenuElem.classList.remove('ytpa-ambilight-settings-menu--advanced')
            }
          }

          if (setting.name === 'showFPS') {
            if(setting.value) {
              this.updateStats()
            } else {
              this.hideStats()
            }
            return
          }

          if(setting.name === 'surroundingContentTextAndBtnOnly') {
            this.updateStyles()
            return
          }

          this.updateSizes()
          this.nextFrame()
        })
      }
    })

    this.updateControlledSettings()
  }

  updateControlledSettings() {
    const videoScaleValue = $.s(`#setting-videoScale-value`)
    if(!this.detectVideoFillScaleEnabled) {
      videoScaleValue.classList.remove('is-controlled-by-setting')
      videoScaleValue.setAttribute('title', '')
    } else {
      videoScaleValue.classList.remove('is-controlled-by-setting')
      videoScaleValue.setAttribute('title', 'Controlled by the "Fill video to screen width" setting.\nManually adjusting this setting will turn off "Fill video to screen width"')
    }

    const horizontalBarsClipPercentageValue = $.s(`#setting-horizontalBarsClipPercentage-value`)
    if(!this.detectHorizontalBarSizeEnabled) {
      horizontalBarsClipPercentageValue.classList.remove('is-controlled-by-setting')
      horizontalBarsClipPercentageValue.setAttribute('title', '')
    } else {
      horizontalBarsClipPercentageValue.classList.add('is-controlled-by-setting')
      horizontalBarsClipPercentageValue.setAttribute('title', 'Controlled by the "Remove black bars" setting.\nManually adjusting this setting will turn off "Remove black bars"')
    }
  }

  getSettingListDisplayText(setting) {
    if (setting.name === 'frameSync') {
      if (setting.value == 0)
        return 'Power Saver'
      if (setting.value == 50)
        return 'Balanced'
      if (setting.value == 100)
        return 'High Performance'
      if (setting.value == 150)
        return 'Perfect (Experimental)'
    }
    if(setting.name === 'framerateLimit') {
      return (this.framerateLimit == 0) ? 'max fps' : `${setting.value} fps`
    }
    return `${setting.value}%`
  }

  settingsMenuOnCloseScrollBottom = 0
  settingsMenuOnCloseScrollHeight = 0
  onSettingsBtnClicked = () => {
    const isOpen = this.settingsMenuElem.classList.contains('is-visible')
    if (isOpen) return

    this.settingsMenuElem.classList.remove('fade-out')
    this.settingsMenuElem.classList.add('is-visible')

    if(this.settingsMenuOnCloseScrollBottom !== -1) {
      const percentage = (this.settingsMenuElem.scrollHeight) / this.settingsMenuOnCloseScrollHeight
      this.settingsMenuElem.scrollTop = (
        (this.settingsMenuElem.scrollHeight - this.settingsMenuElem.offsetHeight) - 
        (this.settingsMenuOnCloseScrollBottom * percentage)
      )
    }

    this.settingsMenuBtn.setAttribute('aria-expanded', true)

    if(this.videoPlayerElem) {
      this.videoPlayerElem.classList.add('ytp-ambilight-settings-shown')
    }

    off(this.settingsMenuBtn, 'click', this.onSettingsBtnClickedListener)
    setTimeout(() => {
      on(body, 'click', this.onCloseSettings, undefined, (listener) => this.onCloseSettingsListener = listener)
    }, 100)
  }

  onCloseSettings = (e) => {
    if (this.settingsMenuElem === e.target || this.settingsMenuElem.contains(e.target))
      return

    this.settingsMenuOnCloseScrollBottom = (!this.settingsMenuElem.scrollTop) 
      ? -1 : 
      (this.settingsMenuElem.scrollHeight - this.settingsMenuElem.offsetHeight) - this.settingsMenuElem.scrollTop
    this.settingsMenuOnCloseScrollHeight = (this.settingsMenuElem.scrollHeight)

    on(this.settingsMenuElem, 'animationend', this.onSettingsFadeOutEnd, undefined, (listener) => this.onSettingsFadeOutEndListener = listener)
    this.settingsMenuElem.classList.add('fade-out')

    this.settingsMenuBtn.setAttribute('aria-expanded', false)

    if(this.videoPlayerElem) {
      this.videoPlayerElem.classList.remove('ytp-ambilight-settings-shown')
    }

    off(body, 'click', this.onCloseSettingsListener)
    setTimeout(() => {
      on(this.settingsMenuBtn, 'click', this.onSettingsBtnClicked, undefined, (listener) => this.onSettingsBtnClickedListener = listener)
    }, 100)
  }

  onSettingsFadeOutEnd = () => {
    this.settingsMenuElem.classList.remove('fade-out', 'is-visible')
    off(this.settingsMenuElem, 'animationend', this.onSettingsFadeOutEndListener)
  }

  setSetting(key, value) {
    this[key] = value

    if (key === 'blur')
      value = Math.round((value - 30) * 10) / 10 // Prevent rounding error
    if (key === 'bloom')
      value = Math.round((value - 7) * 10) / 10 // Prevent rounding error

    const setting = this.settings.find(setting => setting.name === key) || {}
    setting.value = value

    if (!this.setSettingTimeout)
      this.setSettingTimeout = {}

    if (this.setSettingTimeout[key])
      clearTimeout(this.setSettingTimeout[key])

    this.setSettingTimeout[key] = setTimeout(() => {
      try {
        localStorage.setItem(`ambilight-${key}`, value)
      } catch (ex) {
        console.warn('YouTube Ambilight | setSetting', ex)
        //AmbilightSentry.captureExceptionWithDetails(ex)
      }
      this.setSettingTimeout[key] = null
    }, 500)
  }

  getSetting(key) {
    let value = null
    try {
      value = localStorage.getItem(`ambilight-${key}`)
    } catch (ex) {
      console.warn('YouTube Ambilight | getSetting', ex)
      //AmbilightSentry.captureExceptionWithDetails(ex)
    }
    const setting = this.settings.find(setting => setting.name === key) || {}
    if (value === null) {
      value = setting.default
    } else if (setting.type === 'checkbox' || setting.type === 'section') {
      value = (value === 'true')
    } else if (setting.type === 'list') {
      value = parseFloat(value)
      if (key === 'blur')
        value = Math.round((value + 30) * 10) / 10 // Prevent rounding error
      if (key === 'bloom')
        value = Math.round((value + 7) * 10) / 10 // Prevent rounding error
    }

    return value
  }

  removeSetting(key) {
    try {
      localStorage.removeItem(`ambilight-${key}`)
    } catch (ex) {
      console.warn('YouTube Ambilight | removeSetting', ex)
      //AmbilightSentry.captureExceptionWithDetails(ex)
    }
  }
}

let errorEvents = []
const pushErrorEvent = (type, details = {}) => {
  const time = Math.round(performance.now()) / 1000

  if(errorEvents.length) {
    const last = errorEvents.slice(-1)[0]
    const {
      count: lastCount,
      time: lastTime,
      endTime: lastEndTime,
      type: lastType,
      ...lastDetails
    } = last

    if(
      lastType === type && 
      JSON.stringify(lastDetails) === JSON.stringify(details)
    ) {
      last.count = last.count ? last.count + 1 : 2
      last.endTime = time
      return
    }
  }

  let event = {
    type,
    time,
    ...details,
  }
  event.time = time
  errorEvents.push(event)
}

class AmbilightError extends Error {
  constructor(message, details) {
    super(message)
    this.name = 'AmbilightError'
    this.details = details
  }
}

on(window, 'beforeunload', (e) => {
  if(!errorEvents.length) return
  
  pushErrorEvent('tab beforeunload')
}, false)

on(window, 'pagehide', (e) => {
  if(!errorEvents.length) return
  
  pushErrorEvent('tab pagehide')
}, false)

on(document, 'visibilitychange', () => {
  if(document.visibilityState !== 'hidden') return
  if(!errorEvents.length) return
    
  pushErrorEvent('tab visibilitychange hidden')

  const lastEvent = errorEvents[errorEvents.length - 1]
  const lastTime = lastEvent.lastTime || lastEvent.time
  const firstTime = errorEvents[0].time
  if(lastTime - firstTime < 3) {
    return // Give the site 3 seconds to load the watch page or move the video element
  }

  AmbilightSentry.captureExceptionWithDetails(
    new AmbilightError('Closed or hid the webpage tab with pending ambilight errors events', errorEvents)
  )
  errorEvents = []
}, false)

const resetThemeToLightIfSettingIsTrue = () => {
  const key = 'resetThemeToLightOnDisable'
  try {
    const value = (localStorage.getItem(`ambilight-${key}`) === 'true')
    if (!value) return
  } catch (ex) {
    console.warn('YouTube Ambilight | resetThemeToLightIfSettingIsTrue', ex)
    //AmbilightSentry.captureExceptionWithDetails(ex)
    return
  }

  Ambilight.setDarkTheme(false)
}

export const getVideosHTML = () => [...$.sa('video')]
  .reduce((obj, elem, i) => {
    obj[`»('video')[${i}]`] = elem.cloneNode(false).outerHTML
    return obj
  }, {})

export const getPlayerContainersHTML = () => [...$.sa('#player-container')]
  .reduce((obj, elem, i) => {
    obj[`»('#player-container')[${i}]`] = elem.cloneNode(false).outerHTML
    return obj
  }, {})


const ambilightDetectDetachedVideo = (ytdAppElem) => {
  const observer = new MutationObserver(wrapErrorHandler(function detectDetachedVideo(mutationsList, observer) {
    if (!ytdAppElem.hasAttribute('is-watch-page')) return

    const isDetached = (!ambilight.videoElem || !document.contains(ambilight.videoElem))
    if (!isDetached) {
      if(errorEvents.length) {
        errorEvents = []
      }
      return
    }

    const videoElem = ytdAppElem.querySelector('video.html5-main-video')
    if (!videoElem) {
      const details = {
        ...getVideosHTML(),
        ...getPlayerContainersHTML(),
        'ambilight.videoElem': ambilight.videoElem?.cloneNode(false)?.outerHTML,
        'ambilight.videoElem.parentElement': ambilight.videoElem.parentElement?.cloneNode(false)?.outerHTML,
        'ambilight.videoElem.closest("#ytd-player")': ambilight.videoElem.closest("#ytd-player")?.cloneNode(false)?.outerHTML,
        'ambilight.videoElem.closest("#ytd-player").parentElement': ambilight.videoElem.closest("#ytd-player")?.parentElement?.cloneNode(false)?.outerHTML,
        documentContainsAmbilightVideoElem: document.contains(ambilight.videoElem)
      }
      pushErrorEvent('detectDetachedVideo | video detached and no new video', details)
      return
    }

    ambilight.initVideoElem(videoElem)

    if(errorEvents.length) {
      errorEvents = []
    }
  }, true))

  observer.observe(document, {
    attributes: false,
    attributeOldValue: false,
    characterData: false,
    characterDataOldValue: false,
    childList: true,
    subtree: true
  })
}

const tryInitClassicAmbilight = (ytdAppElem) => {
  const classicYtdAppElem = $.s('body[data-spf-name="watch"]')
  if(!Ambilight.isClassic && classicYtdAppElem) {
    AmbilightSentry.captureExceptionWithDetails(new Error('Detected deprecated YouTube classic layout. Support will be removed in future versions.'))
  }
  const classicVideoElem = $.s('video.html5-main-video')
  if(!classicYtdAppElem || !classicVideoElem) return false

  Ambilight.isClassic = true
  window.ambilight = new Ambilight(classicYtdAppElem, classicVideoElem)
  return true
}

const tryInitAmbilight = (ytdAppElem) => {
  if (ytdAppElem.getAttribute('is-watch-page') !== '') return

  const videoElem = ytdAppElem.querySelector('ytd-watch-flexy video.html5-main-video')
  if (!videoElem) {
    const ytPlayerManagerVideoElem = ytdAppElem.querySelector('yt-player-manager video.html5-main-video')
    if(ytPlayerManagerVideoElem) {
      // console.warn('YouTube Ambilight | Waiting for the video to transition from the player-api')
      // console.log(playerApiElem.cloneNode(true))
      pushErrorEvent('tryInitAmbilight | video in yt-player-manager')
      return false
    }
    const ytdMiniplayerVideoElem = ytdAppElem.querySelector('ytd-miniplayer video.html5-main-video')
    if(ytdMiniplayerVideoElem) {
      // console.warn('YouTube Ambilight | Waiting for the video to transition from the miniplayer')
      pushErrorEvent('tryInitAmbilight | video in ytd-miniplayer')
      return false
    }
    const playerApiElem = document.querySelector('#player-api video.html5-main-video')
    if(playerApiElem) {
      pushErrorEvent('tryInitAmbilight | video in #player-api')
      return false
    }
    // console.warn('YouTube Ambilight | Waiting for the video to be created in ytd-app')
    pushErrorEvent('tryInitAmbilight | no video in ytd-app ytd-watch-flexy', {
      ...getVideosHTML(),
      ...getPlayerContainersHTML(),
    })
    return false
  }

  try {
    window.ambilight = new Ambilight(ytdAppElem, videoElem)
  } catch(ex) {
    pushErrorEvent(ex.message)
    throw ex
  }

  errorEvents = []
  ambilightDetectDetachedVideo(ytdAppElem)
  ambilightDetectPageTransition(ytdAppElem)
  return true
}

const ambilightDetectPageTransition = (ytdAppElem) => {
  const observer = new MutationObserver(wrapErrorHandler((mutationsList, observer) => {
    const ytdAppOrBody = mutationsList[0].target
    const isOnVideoPage = !!(
      ytdAppOrBody.getAttribute('data-spf-name') === 'watch' || // body[data-spf-name="watch"]
      ytdAppOrBody.getAttribute('is-watch-page') === '' // ytd-app[is-watch-page]
    )
    if(window.ambilight.isOnVideoPage === isOnVideoPage) return

    window.ambilight.isOnVideoPage = isOnVideoPage
    if (isOnVideoPage) {
      window.ambilight.start()
    } else {
      window.ambilight.hide()
    }
  }))
  observer.observe(ytdAppElem, {
    attributes: true,
    attributeFilter: ['is-watch-page', 'data-spf-name']
  })
}

const loadAmbilight = () => {
  const ytdAppElem = $.s('ytd-app, body[data-spf-name]')
  if(!ytdAppElem) {
    const appElems = [...$.sa('body > *')]
      .filter(elem => elem.tagName.endsWith('-APP'))
      .map(elem => elem.cloneNode(false).outerHTML)
    if(appElems.length) {
      throw new AmbilightError('Found one or more *-app elements but cannot find desktop app element: ytd-app, body[data-spf-name]', appElems)
    }
    return
  }

  // Validated YouTube desktop web app

  if (tryInitAmbilight(ytdAppElem)) return
  if (tryInitClassicAmbilight(ytdAppElem)) return

  // Not initialized yet

  if (ytdAppElem.getAttribute('is-watch-page') === null) {
    resetThemeToLightIfSettingIsTrue()
  }

  // Listen to DOM changes

  const observer = new MutationObserver(wrapErrorHandler((mutationsList, observer) => {
    if (window.ambilight) {
      observer.disconnect()
      return
    }

    if (
      tryInitAmbilight(ytdAppElem) ||
      tryInitClassicAmbilight(ytdAppElem)
    ) {
      // Initialized
      observer.disconnect()
    }
  }, true))
  observer.observe(ytdAppElem, {
    childList: true,
    subtree: true
  })
}

const onLoad = () => {
  requestIdleCallback(function onLoad() {
    if(window.ambilight) return
      
    loadAmbilight()
  }, { timeout: 5000 })
}

try {
  if(document.readyState === 'complete') {
    onLoad()
  } else {
    window.addEventListener('load', onLoad)
  }
} catch (ex) {
  AmbilightSentry.captureExceptionWithDetails(ex)
}