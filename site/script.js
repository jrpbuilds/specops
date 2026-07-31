/**
 * SpecOps site progressive enhancement.
 *
 * Features:
 * - Mobile navigation toggle
 * - Smooth anchor scrolling
 * - Clipboard copy buttons
 * - Active section highlighting in primary nav
 * - Scroll reveal via IntersectionObserver (skipped if reduced motion is preferred)
 */

;(function () {
    "use strict"

    const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)")

    /**
     * ------------------------------------------------------------------------
     * Mobile navigation
     * ------------------------------------------------------------------------
     */
    const navToggle = document.getElementById("nav-toggle")
    const primaryNav = document.getElementById("primary-nav")

    function closeMobileNav() {
        if (!navToggle || !primaryNav) return
        navToggle.setAttribute("aria-expanded", "false")
        primaryNav.classList.remove("is-open")
        document.body.style.overflow = ""
    }

    function openMobileNav() {
        if (!navToggle || !primaryNav) return
        navToggle.setAttribute("aria-expanded", "true")
        primaryNav.classList.add("is-open")
        document.body.style.overflow = "hidden"
    }

    function toggleMobileNav() {
        const isOpen = primaryNav && primaryNav.classList.contains("is-open")
        if (isOpen) {
            closeMobileNav()
        } else {
            openMobileNav()
        }
    }

    if (navToggle && primaryNav) {
        navToggle.addEventListener("click", toggleMobileNav)

        // Close nav when clicking a link (mobile)
        primaryNav.querySelectorAll('a[href^="#"]').forEach(function (link) {
            link.addEventListener("click", closeMobileNav)
        })

        // Close nav on Escape key
        document.addEventListener("keydown", function (event) {
            if (event.key === "Escape" && primaryNav.classList.contains("is-open")) {
                closeMobileNav()
                navToggle.focus()
            }
        })

        // Close nav when clicking outside on mobile
        document.addEventListener("click", function (event) {
            if (
                primaryNav.classList.contains("is-open") &&
                !primaryNav.contains(event.target) &&
                !navToggle.contains(event.target)
            ) {
                closeMobileNav()
            }
        })
    }

    /**
     * ------------------------------------------------------------------------
     * Smooth scroll for same-page anchors
     * ------------------------------------------------------------------------
     */
    document.querySelectorAll('a[href^="#"]').forEach(function (anchor) {
        anchor.addEventListener("click", function (event) {
            const href = anchor.getAttribute("href")
            if (!href || href.length <= 1) return

            const target = document.querySelector(href)
            if (!target) return

            event.preventDefault()

            const header = document.querySelector(".site-header")
            const headerOffset = header ? header.offsetHeight + 16 : 80
            const targetTop = target.getBoundingClientRect().top + window.pageYOffset - headerOffset

            window.scrollTo({
                top: targetTop,
                behavior: prefersReducedMotion.matches ? "auto" : "smooth",
            })

            // Move focus for accessibility
            target.setAttribute("tabindex", "-1")
            target.focus({ preventScroll: true })
        })
    })

    /**
     * ------------------------------------------------------------------------
     * Clipboard copy buttons
     * ------------------------------------------------------------------------
     */
    document.querySelectorAll("[data-copy-target]").forEach(function (button) {
        button.addEventListener("click", function () {
            const targetId = button.getAttribute("data-copy-target")
            const target = document.getElementById(targetId)
            if (!target) return

            const text = target.innerText || target.textContent || ""
            const originalLabel = button.textContent

            function markSuccess() {
                button.textContent = "Copied"
                button.classList.add("copied")
                button.setAttribute("aria-pressed", "true")
                setTimeout(function () {
                    button.textContent = originalLabel
                    button.classList.remove("copied")
                    button.removeAttribute("aria-pressed")
                }, 2000)
            }

            function markFailure() {
                button.textContent = "Failed"
                setTimeout(function () {
                    button.textContent = originalLabel
                }, 2000)
            }

            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(text.trim()).then(markSuccess).catch(markFailure)
            } else {
                // Fallback for older browsers
                try {
                    const textarea = document.createElement("textarea")
                    textarea.value = text.trim()
                    textarea.setAttribute("readonly", "")
                    textarea.style.position = "absolute"
                    textarea.style.left = "-9999px"
                    document.body.appendChild(textarea)
                    textarea.select()
                    document.execCommand("copy")
                    document.body.removeChild(textarea)
                    markSuccess()
                } catch (err) {
                    markFailure()
                }
            }
        })
    })

    /**
     * ------------------------------------------------------------------------
     * Active section highlighting
     * ------------------------------------------------------------------------
     */
    const sections = Array.from(document.querySelectorAll("section[id]"))
    const navLinks = Array.from(document.querySelectorAll('.nav-list a[href^="#"]'))

    function getCurrentSection() {
        const header = document.querySelector(".site-header")
        const headerHeight = header ? header.offsetHeight : 0
        const scrollPos = window.pageYOffset + headerHeight + 48

        // At the bottom of the page the detection line cannot always reach the
        // last section's top (short final section, tall footer, or a tall
        // viewport). Force the last section active so its nav entry
        // highlights, matching the user's actual position.
        const scrollBottom = window.pageYOffset + window.innerHeight
        const documentBottom = document.documentElement.scrollHeight
        if (scrollBottom >= documentBottom - 1) {
            return sections[sections.length - 1] || null
        }

        let current = null
        for (let i = 0; i < sections.length; i++) {
            const section = sections[i]
            if (section.offsetTop <= scrollPos) {
                current = section
            }
        }
        return current
    }

    function updateActiveNav() {
        const currentSection = getCurrentSection()
        if (!currentSection) return

        const id = currentSection.getAttribute("id")
        navLinks.forEach(function (link) {
            const href = link.getAttribute("href")
            if (href === "#" + id) {
                link.classList.add("is-active")
                link.setAttribute("aria-current", "page")
            } else {
                link.classList.remove("is-active")
                link.removeAttribute("aria-current")
            }
        })
    }

    if (sections.length && navLinks.length) {
        let ticking = false
        window.addEventListener("scroll", function () {
            if (!ticking) {
                window.requestAnimationFrame(function () {
                    updateActiveNav()
                    ticking = false
                })
                ticking = true
            }
        })
        updateActiveNav()
    }

    /**
     * ------------------------------------------------------------------------
     * Back to top
     * ------------------------------------------------------------------------
     */
    const backToTop = document.getElementById("back-to-top")

    if (backToTop) {
        function updateBackToTop() {
            if (window.pageYOffset > 400) {
                backToTop.classList.add("is-visible")
                backToTop.hidden = false
            } else {
                backToTop.classList.remove("is-visible")
            }
        }

        backToTop.addEventListener("click", function () {
            window.scrollTo({
                top: 0,
                behavior: prefersReducedMotion.matches ? "auto" : "smooth",
            })
        })

        let backToTopTicking = false
        window.addEventListener("scroll", function () {
            if (!backToTopTicking) {
                window.requestAnimationFrame(function () {
                    updateBackToTop()
                    backToTopTicking = false
                })
                backToTopTicking = true
            }
        })
        updateBackToTop()
    }

    /**
     * ------------------------------------------------------------------------
     * Demo video: play on scroll into view
     * ------------------------------------------------------------------------
     */
    const demoVideo = document.querySelector(".demo-video")

    if (demoVideo && "IntersectionObserver" in window) {
        if (prefersReducedMotion.matches) {
            // Leave the poster visible; do not autoplay the loop.
            demoVideo.removeAttribute("loop")
        } else {
            const demoObserver = new IntersectionObserver(
                function (entries) {
                    entries.forEach(function (entry) {
                        if (entry.isIntersecting) {
                            const playPromise = demoVideo.play()
                            if (playPromise && typeof playPromise.catch === "function") {
                                playPromise.catch(function () {
                                    // Autoplay can be blocked; the poster remains.
                                })
                            }
                        } else {
                            demoVideo.pause()
                        }
                    })
                },
                {
                    threshold: 0.25,
                },
            )
            demoObserver.observe(demoVideo)
        }
    }

    /**
     * ------------------------------------------------------------------------
     * IntersectionObserver reveal
     * ------------------------------------------------------------------------
     */
    if ("IntersectionObserver" in window && !prefersReducedMotion.matches) {
        const revealObserver = new IntersectionObserver(
            function (entries) {
                entries.forEach(function (entry) {
                    if (entry.isIntersecting) {
                        entry.target.classList.add("is-visible")
                        revealObserver.unobserve(entry.target)
                    }
                })
            },
            {
                threshold: 0.12,
                rootMargin: "0px 0px -40px 0px",
            },
        )

        document
            .querySelectorAll(".section, .tier-card, .capability-card, .workflow-step")
            .forEach(function (element) {
                element.classList.add("reveal")
                revealObserver.observe(element)
            })
    }
})()
