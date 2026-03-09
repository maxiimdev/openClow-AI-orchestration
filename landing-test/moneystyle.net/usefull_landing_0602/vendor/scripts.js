/* ===================================================== */
/* ----- OLD NEWSLETTER SUBMIT SCRIPT (DEPRECATED) ----- */
/* ===================================================== */
(() => {
  'use strict';

  const SELECTORS = {
    newsletter: '[data-gjs-type="newsletter"]',
    visibleModal: '[data-gjs-type="modalWrapper"].visible',
  };

  const API_URL = 'https://backend-v2.landerlab.workers.dev/api/v2/leads/create';

  const successSvg = `
    <svg width="146" height="146" viewBox="0 0 146 146" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="73" cy="73" r="54" stroke="#CEFFDB" stroke-width="38"/>
      <path d="M73 15C105.033 15 131 40.9675 131 73C131 105.033 105.033 131 73 131C40.9675 131 15 105.033 15 73C15 40.9675 40.9675 15 73 15ZM98.0383 54.4867C96.717 53.1655 94.6295 53.0774 93.2061 54.2225L92.9117 54.4867L63.575 83.8235L53.0883 73.3367C51.6726 71.9211 49.3774 71.9211 47.9617 73.3367C46.6405 74.658 46.5524 76.7455 47.6975 78.1689L47.9617 78.4633L61.0117 91.5133C62.333 92.8345 64.4205 92.9226 65.8439 91.7775L66.1383 91.5133L98.0383 59.6133C99.4539 58.1976 99.4539 55.9024 98.0383 54.4867Z" fill="#34A853"/>
    </svg>`;

  const closeAllModals = () => {
    document.querySelectorAll(SELECTORS.visibleModal)
      .forEach(modal => modal.classList.remove('visible'));
  };

  const createPopup = (message, description) => {
    const popup = document.createElement('div');
    popup.setAttribute('ll-submit-popup', 'true');
    popup.innerHTML = `
      <div>
        ${successSvg}
        <h3>${message}</h3>
        ${description ? `<p>${description}</p>` : ''}
      </div>`;
    return popup;
  };

  const showPopup = (popup, redirectUrl) => {
    document.body.append(popup);
    setTimeout(() => popup.classList.add('visible')); // keep original timing
  
    setTimeout(() => {
      popup.classList.remove('visible');
      setTimeout(() => {
        popup.remove();
        if (redirectUrl) window.open(redirectUrl, '_self');
      }, 500);
    }, 1500);
  };

  const buildPayload = (newsletter, field) => ({
    formToken: newsletter.getAttribute('ll-newsletter-id'),
    variantId: window.LL_VARIANT_ID,
    landerId: window.LL_LANDER_ID,
    userId: window.LL_USER_ID,
    data: [{ key: field.id, value: field.value, label: field.name }],
  });

  const submitLead = async (payload) => {
    try {
      await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      console.error(err);
    }
  };

  const handleSubmit = async (e, newsletter) => {
    e.preventDefault();
    closeAllModals();

    const message = newsletter.getAttribute('newsletter-submit-msg') || 'Thank You!';
    const redirectUrl = newsletter.getAttribute('newsletter-redirect-url');
    const description = newsletter.getAttribute('newsletter-submit-description');

    const popup = createPopup(message, description);
    showPopup(popup, redirectUrl);

    const field = newsletter.querySelector('input');
    const payload = buildPayload(newsletter, field);
    field.value = '';

    await submitLead(payload);
  };

  document.querySelectorAll(SELECTORS.newsletter)
    .forEach(newsletter => {
      newsletter.addEventListener('submit', (e) => handleSubmit(e, newsletter));
    });
})();
  
/* ===================================================== */
/* ---------- OLD NAVBAR SCRIPT (DEPRECATED) ----------- */
/* ===================================================== */
(() => {
  'use strict';

  const SELECTOR = {
    navbar: '[ll-navbar-container]',
    toggler: '[ll-navbar-toggler]',
    link: '[ll-navbar-link]',
  };

  const navbars = document.querySelectorAll(`nav${SELECTOR.navbar}`);
  const navToggle = document.querySelector(SELECTOR.toggler);
  const navLinks = document.querySelectorAll(SELECTOR.link);

  const collapseNavbar = (nav) => {
    nav.removeAttribute('expanded');
    document.body.style.overflowY = 'unset';
  };

  const toggleNavbar = (el) => {
    const container = el.closest(SELECTOR.navbar);
    if (container.getAttribute('expanded')) {
      container.removeAttribute('expanded');
      document.body.style.overflow = 'auto';
    } else {
      container.setAttribute('expanded', true);
      document.body.style.overflow = 'hidden';
    }
  };

  window.addEventListener('resize', (e) => {
    if (e.target.innerWidth > 993 && navbars.length) {
      navbars.forEach(nav => {
        if (nav.getAttribute('expanded')) collapseNavbar(nav);
      });
    }
  });

  if (navToggle) {
    navToggle.addEventListener('click', (e) => toggleNavbar(e.target));

    if (window.innerWidth <= 992) {
      navLinks.forEach(link => {
        link.addEventListener('click', () => toggleNavbar(link));
      });
    }
  }
})();
  
  // OPEN MODAL ON LOAD SCRIPT
  window.addEventListener('DOMContentLoaded', () => {
    const modals = [...document.querySelectorAll('[ll-modal-name]')];
  
    if (!modals.length) return;
  
    modals.forEach((modal) => {
      const modalWithTimer = modal.querySelector('[open-on-load]');
      if (!modalWithTimer) return;
      const time = +modalWithTimer.getAttribute('open-on-load');
  
      setTimeout(() => {
        modal.classList.add('visible');
      }, time * 1000);
    });
  });

/* ===================================================== */
/* -------- OLD ACCORDION SCRIPT (DEPRECATED) ---------- */
/* ===================================================== */
  (() => {
    'use strict';
  
    const SELECTORS = {
      collapse: '[data-gjs-type="collapse"]',
      header: '.ll-collapse-header',
    };
  
    document.querySelectorAll(SELECTORS.collapse).forEach(collapse => {
      collapse.querySelector(SELECTORS.header).addEventListener('click', (e) => {
        e.preventDefault();
        collapse.classList.toggle('expanded');
      });
    });
  })();
  
  /* NEW FORM SUBMIT SCRIPT */
  /* NEW FORM SUBMIT SCRIPT */
  /* NEW FORM SUBMIT SCRIPT */
  const ll__forms = [...document.querySelectorAll('[data-ll-form]')];
  const hasTelInput = document.querySelector('[data-ll-form] input[type="tel"]');

  function getCountryCodeFromCookie() {
    const match = document.cookie.match(/llRequestData=({.*?})/);
    if (match) {
      const data = JSON.parse(decodeURIComponent(match[1]));
      return data.countrycode || 'US';
    }
    return 'US';
  }

  if (hasTelInput) {
    const scriptEl = document.createElement('script');
    scriptEl.setAttribute(
      'src',
      'https://cdn-landerlab.com/landerlab-assets/js/intlTelInput.min.js'
    );
    document.body.appendChild(scriptEl);
    document.head.insertAdjacentHTML(
      'beforeend',
      `<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/intl-tel-input@20.3.0/build/css/intlTelInput.css" />`
    );
  
    scriptEl.onload = function () {
      // Cleanup onload handler
      scriptEl.onload = null;
      ll__forms.forEach((form) => {
        const telTypes = form.querySelectorAll('input[type="tel"]');
        telTypes.forEach((telType) => {
          window.intlTelInput(telType, {
            strictMode: true,
            initialCountry: getCountryCodeFromCookie(),
            utilsScript: 'https://cdn-landerlab.com/landerlab-assets/js/utils.js',
          });
        });
      });
    };
  }

  if (ll__forms.length) {
    ll__forms.forEach((form) => {
      form.addEventListener('submit', async (e) => {
        e.preventDefault();

        /* Close All Popups */
        const visiblePopups = document.querySelectorAll(
          '[data-gjs-type="modalWrapper"].visible'
        );
        if (visiblePopups.length)
          visiblePopups.forEach((p) => p.classList.remove('visible'));

        const message = form.dataset.llFormMessage || 'Submited Succesfully!';
        const description = form.dataset.llFormDescription || '';
        const redirectUrl = form.dataset.llFormRedirect;
        const appendUrlParameters = form.dataset.llFormAppendParameters === 'true';
        const popupDuration = Number(form.dataset.llFormPopupDuration) || 2000;
        const trustedFormCertUrl = document.querySelector('[name="xxTrustedFormCertUrl"]')?.value || '';
        const jornayaLeadId = window.LeadiD?.token || '';
        const clickFlareClickId = window.clickflare?.tracking_params?.click_id;
        let recaptchaScore = '';

        if(window.RECAPTCHA_V3_SITE_KEY) {
          recaptchaScore = await new Promise(resolve => 
            grecaptcha.ready(() => grecaptcha.execute(window.RECAPTCHA_V3_SITE_KEY, {action:'submit'}).then(resolve))
          );
        }

        // if (redirectUrl) { 
        //   setTimeout(() => {
        //     window.open(redirectUrl, form.getAttribute('target') === '_blank' ? '_blank' : '_self'); 
        //   }, 300);
        // } else {
        //   const submitPopUp = document.createElement('div');
        //   submitPopUp.setAttribute('ll-submit-popup', 'true');
        //   submitPopUp.innerHTML = `
        //   <div>
        //   <svg width="146" height="146" viewBox="0 0 146 146" fill="none" xmlns="http://www.w3.org/2000/svg" >
        //       <circle cx="73" cy="73" r="54" stroke="#CEFFDB" stroke-width="38" />
        //       <path
        //         d="M73 15C105.033 15 131 40.9675 131 73C131 105.033 105.033 131 73 131C40.9675 131 15 105.033 15 73C15 40.9675 40.9675 15 73 15ZM98.0383 54.4867C96.717 53.1655 94.6295 53.0774 93.2061 54.2225L92.9117 54.4867L63.575 83.8235L53.0883 73.3367C51.6726 71.9211 49.3774 71.9211 47.9617 73.3367C46.6405 74.658 46.5524 76.7455 47.6975 78.1689L47.9617 78.4633L61.0117 91.5133C62.333 92.8345 64.4205 92.9226 65.8439 91.7775L66.1383 91.5133L98.0383 59.6133C99.4539 58.1976 99.4539 55.9024 98.0383 54.4867Z"
        //         fill="#34A853"
        //       />
        //   </svg>
        //     <h3>${message}</h3>
        //     ${description ? `<p>${description}</p>` : ''}
        //   </div>`;
        //   setTimeout(() => {
        //     submitPopUp.classList.add('visible');
        //   });
        //   document.body.insertAdjacentElement('beforeend', submitPopUp);
        //   setTimeout(() => {
        //     submitPopUp.classList.remove('visible');
        //     setTimeout(() => submitPopUp.remove(), 500);
        //   }, 1500);
        // }

        
        if(!redirectUrl || form.dataset.llFormPopupDuration) {
          const submitPopUp = document.createElement('div');
          submitPopUp.setAttribute('ll-submit-popup', 'true');
          submitPopUp.innerHTML = `
          <div>
          <svg width="146" height="146" viewBox="0 0 146 146" fill="none" xmlns="http://www.w3.org/2000/svg" >
              <circle cx="73" cy="73" r="54" stroke="#CEFFDB" stroke-width="38" />
              <path
                d="M73 15C105.033 15 131 40.9675 131 73C131 105.033 105.033 131 73 131C40.9675 131 15 105.033 15 73C15 40.9675 40.9675 15 73 15ZM98.0383 54.4867C96.717 53.1655 94.6295 53.0774 93.2061 54.2225L92.9117 54.4867L63.575 83.8235L53.0883 73.3367C51.6726 71.9211 49.3774 71.9211 47.9617 73.3367C46.6405 74.658 46.5524 76.7455 47.6975 78.1689L47.9617 78.4633L61.0117 91.5133C62.333 92.8345 64.4205 92.9226 65.8439 91.7775L66.1383 91.5133L98.0383 59.6133C99.4539 58.1976 99.4539 55.9024 98.0383 54.4867Z"
                fill="#34A853"
              />
          </svg>
            <h3>${message}</h3>
            ${description ? `<p>${description}</p>` : ''}
          </div>`;
          setTimeout(() => {
            submitPopUp.classList.add('visible');
          });
          document.body.insertAdjacentElement('beforeend', submitPopUp);
          const setTimeoutTime = window.FORM_SUBMIT_POPUP_DURATION || 500;
          setTimeout(() => {
            submitPopUp.classList.remove('visible');
            setTimeout(() => submitPopUp.remove(), setTimeoutTime);
          }, popupDuration);
        }

        const payload = {
          formToken: form.dataset.llFormId,
          variantId: window.LL_VARIANT_ID,
          landerId: window.LL_LANDER_ID,
          userId: window.LL_USER_ID,
          data: [],
        };

        const fields = form.querySelectorAll('[data-input-wrapper]');

        fields.forEach((field) => {
          const { inputWrapper } = field.dataset;
          if (inputWrapper === 'html') return;

          const input = field.querySelector('input');
          const select = field.querySelector('select');
          const textarea = field.querySelector('textarea');

          const data = {
            key: field.dataset.inputId,
            value: input ? input.value : '',
            label: field.dataset.inputLabel,
          };

          if (inputWrapper === 'tel') {
            const isIntlInput = !!field.querySelector('[data-intl-tel-input-id]');
            if (isIntlInput) {
              const telInput = field.querySelector('[type="tel"]');
              const countryCodeEl = field.querySelector('.iti__a11y-text');
              const countryCode = countryCodeEl?.textContent.split('+').pop();
              data.value = `+${countryCode} ${telInput.value.replace(`+${countryCode}`, '')}`.replace(/[-\s()]/g, '').replace('+Nocountryselected', '');
              telInput.value = '';
            }
          }

          if (input) {
            // if (input.type === 'email') data.label = 'Email';
            if (input.type === 'datetime-local') data.value = data.value.replace('T', ' ');
            if (input.type === 'checkbox' && inputWrapper === 'checkbox-group') {
              const inputs = [...field.querySelectorAll('input')];
              const checkedInput = inputs.filter((i) => i.checked);
              if (checkedInput.length)
                data.value = checkedInput.map((i) => i.value).join(', ');
              else data.value = '';
              inputs.forEach((input) => (input.checked = false));
            } else if (input.type === 'checkbox') {
              data.value = input.checked ? 'Yes' : 'No';
              input.checked = false;
            } else if (input.type === 'radio') {
              const inputs = [...field.querySelectorAll('input')];
              const checkedInput = inputs.find((i) => i.checked);
              if (checkedInput) data.value = checkedInput.value;
              else data.value = '';
              inputs.forEach((input) => (input.checked = false));
            } else {
              input.value = '';
            }
          }

          if (select) {
            data.value = select.value || '';
            const options = [...field.querySelectorAll('option')];
            select.value = options[0].value;
          }
          if (textarea) {
            data.value = textarea.value || '';
            textarea.value = '';
          } 

          payload.data.push(data);
        });

        if (clickFlareClickId) payload.data.push({ key: Math.random().toString(36).substring(2), value: clickFlareClickId, label: 'ClickFlare Click Id' });
        if (trustedFormCertUrl) payload.data.push({ key: Math.random().toString(36).substring(2), value: trustedFormCertUrl, label: 'Trusted Form Cert Url' });
        if (jornayaLeadId) payload.data.push({ key: Math.random().toString(36).substring(2), value: jornayaLeadId, label: 'Jornaya Lead Id' });
        if (recaptchaScore) payload.data.push({ key: Math.random().toString(36).substring(2), value: recaptchaScore, label: 'Recaptcha V3 Score' });

        try {
          const response = await fetch(
            'https://backend-v2.landerlab.workers.dev/api/v2/leads/create',
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
              },
              body: JSON.stringify(payload),
            }
          );
        } catch (err) {
          console.error(err);
        } finally {
          if (redirectUrl) { 
            setTimeout(() => {
              if (appendUrlParameters) {
                const separator = redirectUrl.includes('?') ? '&' : '?';
                const params = payload.data.map(item => `${item.label}=${item.value}`).join('&');
                const newUrl = redirectUrl + separator + params;
                window.open(newUrl, form.getAttribute('target') === '_blank' ? '_blank' : '_self'); 
              } else {
                window.open(redirectUrl, form.getAttribute('target') === '_blank' ? '_blank' : '_self'); 
              }
            }, form.dataset.llFormPopupDuration ? popupDuration : 300);
          }
        }
      });
    });
  }
  
  /* UPDATED CLICK EVENT SCRIPT */
  /* UPDATED CLICK EVENT SCRIPT */
  /* UPDATED CLICK EVENT SCRIPT */
  const ll_event_elmenets = document.querySelectorAll('[data-ll-event]');
  
  ll_event_elmenets.forEach((el) => {
    const type = el.dataset.llEvent;
    let href = el.getAttribute('href');
    let target = el.getAttribute('target');
  
    ll_run_event(el, href, target, type);
  });
  
  const addUrlQueryParams = (href, target) => {
    let url =
      href +
      (href.split('?')[1] ? '&' : '?') +
      window.location.search.replace('?', '');
  
    url =
      url.endsWith('?') || url.endsWith('&') ? url.slice(0, url.length - 1) : url;
    window.open(url, target ? '_blank' : '_self');
  };
  
  function ll_run_event(el, href, target, type, event = 'click') {
    if (type === 'popup') {
      const openedPopups = document.querySelectorAll('[ll-modal-name]');
      openedPopups.forEach((modal) => modal.classList.remove('visibility'));
  
      const modalId = el.dataset.llModal;
      el.addEventListener(event, (e) => {
        e.preventDefault();
        const modal = document.querySelector(`[ll-modal-id="${modalId}"]`);
        const countdowns = modal.querySelectorAll('[data-countdown-id]');
        countdowns.forEach((countdown) => {
          triggerCountdown(countdown);
        });    
        modal.classList.add('visible');
      });
  
      return;
    }
  
    el.addEventListener(event, (e) => {
      e.preventDefault();
  
      if (type === 'redirect') {
        const passBtnTextToUrl = el.dataset.passBtnText;
        
        if (passBtnTextToUrl) {
          const buttonText = el.innerText;
          href = `${href}${href.includes('?') ? '&' : '?'}${passBtnTextToUrl}=${buttonText}`;
        }
        
        if (el.dataset.llUrlQueryParams) addUrlQueryParams(parseHref(href), target);
        else window.open(parseHref(href), target ? '_blank' : '_self');
      }
      if (type === 'id') {
        const closestModal = el.closest('[data-gjs-type="modalWrapper"].visible');
        if (closestModal) closestModal.classList.remove('visible');
        document.querySelector(href).scrollIntoView({ behavior: 'smooth' });
      }
      if (type === 'email') window.location.href = href;
      if (type === 'phone') window.open(href);
    });
  }
  
  /* MODAL SCRIPT */
  const ll_popup_elments = document.querySelectorAll('[ll-modal-id]');
  
  ll_popup_elments.forEach((popup) => {
    popup.querySelector('[ll-modal-backdrop]').addEventListener('click', () => {
      popup.classList.remove('visible');
    });
    popup.querySelector('[ll-modal-close]').addEventListener('click', () => {
      popup.classList.remove('visible');
    });
  });
  
  /* LINKS WITH URL QUERY PARAMS */
  const ll_links_with_query_params = document.querySelectorAll(
    'a[data-ll-url-query-params]'
  );
  
  ll_links_with_query_params.forEach((link) => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      addUrlQueryParams(link.href, !!link.target);
    });
  });
  
  /* STICKY BAR */
  /* STICKY BAR */
  /* STICKY BAR */
  /* STICKY BAR */
  const ll_sticky_bar_function = () => {
    const ll_sticky_bars = [
      ...document.querySelectorAll('[data-gjs-type="sticky-bar"]'),
    ];
  
    const ll_top_bars = ll_sticky_bars.filter(
      (el) =>
        el.dataset.stickyBarVertical === 'top' && !el.dataset.stickyBarScroll
    );
    const ll_bottom_bars = ll_sticky_bars.filter(
      (el) => el.dataset.stickyBarVertical === 'bottom'
    );
  
    const ll_top_full_bars = ll_top_bars.filter((el) => el.dataset.stickyBarFull);
    const ll_bottom_full_bars = ll_bottom_bars.filter(
      (el) => el.dataset.stickyBarFull
    );
  
    const ll_sticky_bar_event = (topBars, bottomBars) => {
      const ll_top_bar_height = topBars.map(
        (el) => el.getBoundingClientRect().height
      );
      const ll_bottom_bar_height = bottomBars.map(
        (el) => el.getBoundingClientRect().height
      );
  
      const addPaddingToBody = () => {
        if (ll_top_bar_height.length) {
          document.body.style.paddingTop = Math.max(...ll_top_bar_height) + 'px';
        } else document.body.style.paddingTop = 0;
  
        if (ll_bottom_bar_height.length) {
          document.body.style.paddingBottom =
            Math.max(...ll_bottom_bar_height) + 'px';
        } else document.body.style.paddingBottom = 0;
      };
  
      addPaddingToBody();
    };
  
    if (window.innerWidth > 992)
      ll_sticky_bar_event(ll_top_full_bars, ll_bottom_full_bars);
    else ll_sticky_bar_event(ll_top_bars, ll_bottom_bars);
  
    window.addEventListener('resize', () => {
      if (window.innerWidth > 992)
        ll_sticky_bar_event(ll_top_full_bars, ll_bottom_full_bars);
      else ll_sticky_bar_event(ll_top_bars, ll_bottom_bars);
    });
  };
  
  ll_sticky_bar_function();
  const ll_sticky_bar_on_scroll = document.querySelectorAll(
    '[data-sticky-bar-scroll]'
  );
  
  const showStickyBarOnScroll = () => {
    ll_sticky_bar_on_scroll.forEach((stickyBar) => {
      const stickyBarScroll = stickyBar.dataset.stickyBarScroll.split(',');
      const innerWidth = window.innerWidth;
  
      let scrollBarScrollValue = stickyBarScroll[0];
  
      if (innerWidth <= 576) scrollBarScrollValue = stickyBarScroll[2];
      else if (innerWidth <= 992) scrollBarScrollValue = stickyBarScroll[1];
  
      const body = document.body;
      const scrollableHeight = body.scrollHeight - window.innerHeight;
      const scrollY = window.scrollY;
      const scrollPercentage = (scrollY / scrollableHeight) * 100;
  
      if (scrollPercentage >= scrollBarScrollValue) {
        stickyBar.classList.add('visible');
      } else {
        stickyBar.classList.remove('visible');
      }
    });
  };
  
  window.addEventListener('scroll', showStickyBarOnScroll);
  
  /* POPUP SCRIPT */
  /* POPUP SCRIPT*/
  /* POPUP SCRIPT*/
  /* POPUP SCRIPT*/
  window.addEventListener('DOMContentLoaded', () => {
      const ll_popups_triggers_script = () => {
    const llPopups = document.querySelectorAll('[ll-modal-wrapper="true"]');
  
    llPopups.forEach((popup) => {
      const countdowns = popup.querySelectorAll('[data-countdown-id]');
      const { llTimeSpent, llExitIntent } = popup.dataset;

      /* Time spent on the website */
      if (llTimeSpent >= 0) {
        setTimeout(
          () => {
            popup.classList.add('visible')
            countdowns.forEach((countdown) => {
              triggerCountdown(countdown);
            });  
          },
          Number(llTimeSpent) * 1000
        );
      }
  
      if (llExitIntent) {
        /* Exit Intent */
        window.addEventListener('mouseout', (event) => {
          const { llExitModalShown } = popup.dataset;
          if (llExitModalShown || event.relatedTarget || event.clientY > 0) return;
          popup.classList.add('visible');
          countdowns.forEach((countdown) => {
            triggerCountdown(countdown);
          });  
          popup.setAttribute('data-ll-exit-modal-shown', true);
        });

        // document.addEventListener('mouseleave', () => {
        //   const { llExitModalShown } = popup.dataset;
        //   if (llExitModalShown) return;
        //   // if (llExitModalShown) return;
        //   popup.classList.add('visible');
        //   popup.setAttribute('data-ll-exit-modal-shown', true);
        // });
      }
    });
      
       const showModalOnScroll = () => {
         
         llPopups.forEach((popup) => {
        const countdowns = popup.querySelectorAll('[data-countdown-id]');
        const { llScrollModalShown, llScrollDepth } = popup.dataset;
  
        if (!llScrollDepth || llScrollModalShown) return;
  
        const llScrollDepthArr = popup.dataset.llScrollDepth.split(',');
        const innerWidth = window.innerWidth;
  
        let popupScrollvalue = llScrollDepthArr[0];
        if (innerWidth <= 576) popupScrollvalue = llScrollDepthArr[2];
        else if (innerWidth <= 992) popupScrollvalue = llScrollDepthArr[1];
  
        const body = document.body;
        const scrollableHeight = body.scrollHeight - window.innerHeight;
        const scrollY = window.scrollY;
        const scrollPercentage = (scrollY / scrollableHeight) * 100;
  
        if (scrollPercentage >= popupScrollvalue) {
          popup.classList.add('visible');
          popup.setAttribute('data-ll-scroll-modal-shown', true);
          countdowns.forEach((countdown) => {
            triggerCountdown(countdown);
          });    
        }
      });
    };
  
    window.addEventListener('scroll', showModalOnScroll);
  };
  
  ll_popups_triggers_script();
  });


  /* Close Popup From Quiz */
  document.addEventListener('closePopup', () => {
    // Select visible popup
    const visiblePopup = document.querySelector(
      '[data-gjs-type="modalWrapper"].visible'
    );
    if (visiblePopup) {
      visiblePopup.classList.remove('visible');
    }
  });

  
  
/* REPLACE EVERY HREF WITH HTTPS */
/* REPLACE EVERY HREF WITH HTTPS */
/* REPLACE EVERY HREF WITH HTTPS */
const SKIP_PROTOCOLS = [
  '//',
  '#',
  'tel:',
  'mailto:',
  'sms:',
  'javascript:',
  'data:',
  'blob:',
  'file:',
  'ftp:',
  'whatsapp:',
  'viber:',
  'skype:',
  'facetime:',
  'facetime-audio:',
  'maps:',
  'geo:',
  'intent:',
  'market:',
  'itms-apps:',
  'spotify:',
  'slack:',
  'zoommtg:',
  'tg:',
];

const ll_links_for_replace = document.querySelectorAll('a');

ll_links_for_replace.forEach((el) => {
  const hrefAttr = el.getAttribute('href');
  if (!hrefAttr) return;
  if (el.dataset.llEvent) return;
  
  const shouldSkip = SKIP_PROTOCOLS.some(protocol => hrefAttr.startsWith(protocol));
  if (shouldSkip) return;

  el.href = parseHref(hrefAttr);
});
  
  function parseHref(href) {
    const replacedLink = href.replace(/^https?:\/\//, '');
    return `https://${replacedLink}`;
  }
  
  /* DAY PICKER SCRIPT */
  /* DAY PICKER SCRIPT */
  /* DAY PICKER SCRIPT */
  /* DAY PICKER SCRIPT */
  /* DAY PICKER SCRIPT */
  const ll_day_pickers = document.querySelectorAll('[data-gjs-type="date-picker"]');
  
  ll_day_pickers.forEach((el) => {
    const { dateDaysBefore, dateFormat } = el.dataset;
    const dateSpan = el.querySelector('[data-date-text-date]');
    const setdate = new Date();
    setdate.setDate(setdate.getDate() - Number(dateDaysBefore));
      
    if(dateFormat === 'year') dateSpan.innerText =  new Date().getFullYear();
    else dateSpan.innerText = setdate.toLocaleString('en-us', { dateStyle: dateFormat,});
  });
  
  /* COUNTDOWN SCRIPT */
  /* COUNTDOWN SCRIPT */
  /* COUNTDOWN SCRIPT */
  /* COUNTDOWN SCRIPT */
  /* COUNTDOWN SCRIPT */
  const LLCountdowns = document.querySelectorAll('[data-countdown-id]');
  const LLCountdownsCookie = getLLCountdownCookie();
  
  LLCountdowns.forEach((countdown) => {
    if (countdown.closest('[ll-modal-wrapper="true"]')) return;
    triggerCountdown(countdown);
  });

  function triggerCountdown(countdown) {
    const { countdownId, countdownTime } = countdown.dataset;
  
    if (
      !LLCountdownsCookie[countdownId] ||
      Number(countdownTime) !== LLCountdownsCookie[countdownId].time
    ) {
      LLCountdownsCookie[countdownId] = {
        time: Number(countdownTime),
        date: Date.now(),
      };
    }
  
    const interval = setInterval(() => {
      const time =
        LLCountdownsCookie[countdownId].date +
        LLCountdownsCookie[countdownId].time -
        Date.now();
  
      if (!countdown.classList.contains('ll-countdown-visible'))
        countdown.classList.add('ll-countdown-visible');
  
      if (time <= 0) {
        clearInterval(interval);
        updateLLCountdownTime(countdown, 0);
      } else updateLLCountdownTime(countdown, time);
    }, 500);
  };

  setLLCountdownCookie(LLCountdownsCookie);
  /* Update LL Countdown DOM */
  function updateLLCountdownTime(element, time) {
    const dayMs = Math.floor(time / (1000 * 60 * 60 * 24));
    const hourMs = Math.floor(time / (1000 * 60 * 60));
    const minMs = Math.floor(time / (1000 * 60));
    const secMs = Math.floor(time / 1000);
  
    const day = dayMs.toString().padStart(2, '0');
    const hour = (hourMs - dayMs * 24).toString().padStart(2, '0');
    const min = (minMs - hourMs * 60).toString().padStart(2, '0');
    const sec = (secMs - minMs * 60).toString().padStart(2, '0');
  
    element.querySelector(
      '[data-countdown-group="day"] [data-countdown-value]'
    ).innerText = day;
    element.querySelector(
      '[data-countdown-group="hour"] [data-countdown-value]'
    ).innerText = hour;
    element.querySelector(
      '[data-countdown-group="min"] [data-countdown-value]'
    ).innerText = min;
    element.querySelector(
      '[data-countdown-group="sec"] [data-countdown-value]'
    ).innerText = sec;
  }
  /* Get Coutndown Cookie Function */
  function getLLCountdownCookie() {
    const llCountdownCookie = document.cookie
      .split('; ')
      .find((cookie) => cookie.startsWith('llCountdown='));
    if (llCountdownCookie) {
      const llCountdownValue = llCountdownCookie.split('=')[1];
      try {
        return JSON.parse(llCountdownValue);
      } catch (error) {
        return {};
      }
    }
    return {};
  }
  /* Set Countdown Cookie Function */
  function setLLCountdownCookie(value) {
    document.cookie = 'llCountdown=' + JSON.stringify(value);
  }

  /* SPINNER SCRIPT */
  /* SPINNER SCRIPT */
  /* SPINNER SCRIPT */
  /* SPINNER SCRIPT */
  const ll_spiners = document.querySelectorAll('[data-gjs-type="spinner"]');

  ll_spiners.forEach((spinner) => {
    const ll_spinner_img = spinner.querySelector('img');
    ll_spinner_img.style.transform = 'translate(-50%, -50%) rotate(0deg)';

    spinner.addEventListener('click', () => {
      if (spinner.classList.contains('ll-spinner--spin')) return;
      const { spinDeg, spinnerLossDeg } = spinner.dataset;
      const type = spinner.dataset.spinnerEvent;
      let href = spinner.getAttribute('href');
      let target = spinner.getAttribute('target');

      if (spinnerLossDeg) {
        ll_spinner_add_spin(spinner, ll_spinner_img, +spinnerLossDeg + 720);

        setTimeout(() => {
          const startingDegree = 360 - +spinnerLossDeg;
          const endDegree =
            +spinnerLossDeg + 720 + startingDegree + +spinDeg + 720;
            
          spinner.classList.remove('ll-spinner--spin');
          ll_spinner_add_spin(spinner, ll_spinner_img, endDegree);

          /* After spinning is completed */
          setTimeout(
            () => ll_spinner_run_event(spinner, href, target, type),
            6000
          );
        }, 6000);

        console.log(360 - +spinnerLossDeg);
        return;
      }

      /* Add Rotation in Styles */
      ll_spinner_img.style.transform = `translate(-50%, -50%) rotate(${
        +spinDeg + 720
      }deg)`;
      /* Add spinning class */
      spinner.classList.add('ll-spinner--spin');

      /* After spinning is completed */
      setTimeout(() => ll_spinner_run_event(spinner, href, target, type), 6000);
    });
  });

  function ll_spinner_add_spin(spinner, img, degree) {
    img.style.transform = `translate(-50%, -50%) rotate(${degree}deg)`;
    spinner.classList.add('ll-spinner--spin');
  }

  function ll_spinner_run_event(el, href, target, type) {
    if (type === 'popup') {
      const openedPopups = document.querySelectorAll('[ll-modal-name]');
      openedPopups.forEach((modal) => modal.classList.remove('visibility'));
      const modalId = el.dataset.llModal;
      const modal = document.querySelector(`[ll-modal-id="${modalId}"]`);
      modal.classList.add('visible');
      return;
    }
    if (type === 'redirect')
      window.open(parseHref(href), target ? '_blank' : '_self');
    if (type === 'id') {
      const targetEl = document.querySelector(href);
      targetEl.style.display = 'unset';
      targetEl.scrollIntoView({ behavior: 'smooth' });
    }
  }


/* VIDEO SCRIPT */
/* VIDEO SCRIPT */
/* VIDEO SCRIPT */
/* VIDEO SCRIPT */
const ll_video_elements = document.querySelectorAll('[data-gjs-type="ll-video"]');

ll_video_elements.forEach((el) => {
  const { videoType, videoAutoplay, videoLoop, videoControls, videoMute, videoSrc } = el.dataset;
  const muteString = videoType === 'vimeo' ? 'muted=1' : 'mute=1';
  const srcString = `${videoSrc}&${videoAutoplay ? 'autoplay=1&' : ''}${videoControls ? '' : 'controls=0&'}${videoLoop ? 'loop=1&' : ''}${videoMute ? muteString : ''}`;

  if (videoType === 'video') {
    el.innerHTML = `<video src="${videoSrc}" ${videoControls ? 'controls' : ''}${videoMute ? 'muted' : ''} ${videoLoop ? 'loop' : ''} ${videoAutoplay ? 'autoplay' : ''}> </video>`;
  } else if (videoType === 'youtube') {
    el.innerHTML = `<iframe src="${srcString}" title="YouTube video player" allow="autoplay; fullscreen; picture-in-picture" allowfullscreen></iframe>`;
  } else if (videoType === 'vimeo') {
    el.innerHTML = `<iframe src="${srcString}" allow="autoplay; fullscreen; picture-in-picture" allowfullscreen></iframe>`;
  }
});


/* ===================================================== */
/* ------FORM RECAPTCHA AND TURNSTILE SCRIPT ----------- */
/* ===================================================== */

/**
 * Form CAPTCHA Integration Script
 *
 * This script initializes and manages Google reCAPTCHA v2 and Cloudflare Turnstile
 * for forms with the data attribute 'data-gjs-type="ll-form"'.
 *
 * Features:
 * - Automatic detection and initialization of CAPTCHA widgets
 * - Submit button disabling until CAPTCHA validation passes
 * - Support for both visible and invisible reCAPTCHA
 * - Retry mechanism for library loading
 * - Error handling and logging
 */

// Initialize CAPTCHA systems when DOM is fully loaded
document.addEventListener('DOMContentLoaded', () => {
  // Get CAPTCHA configuration from global variables
  const googleRecaptchaV2SiteKey = window.LL_RECAPTCHA_V2_SITE_KEY;
  const googleRecaptchaV2Size = window.LL_RECAPTCHA_V2_SIZE;
  const cfTurnstileSiteKey = window.LL_CF_TURNSTILE_SITE_KEY;

  if (googleRecaptchaV2SiteKey || cfTurnstileSiteKey) {
    // Find all forms that should have CAPTCHA protection
    const llForms = document.querySelectorAll('[data-gjs-type="ll-form"]');

    // Process each form individually
    llForms.forEach((llForm) => {
      // Find the submit button within this form
      const submitButton = llForm.querySelector('button[type="submit"]');

      // Only proceed if at least one CAPTCHA service is configured
      // Disable submit button initially to prevent submission without CAPTCHA validation
      if (submitButton) submitButton.setAttribute('disabled', 'true');

      // Initialize Google reCAPTCHA v2 if configured and script is present
      if (googleRecaptchaV2SiteKey && submitButton) {
        if (typeof window.grecaptcha !== 'undefined') {
          createFormCaptchaCallback(llForm.id);
          initializeGoogleRecaptchaForForm(llForm, submitButton, googleRecaptchaV2SiteKey, googleRecaptchaV2Size);
        } else {
          console.warn('Google reCAPTCHA script not found in page. Please include the reCAPTCHA script.');
        }
      }

      // Initialize Cloudflare Turnstile if configured and script is present
      if (cfTurnstileSiteKey && submitButton) {
        if (typeof window.turnstile !== 'undefined') {
          createFormCaptchaCallback(llForm.id);
          initializeCloudflareTurnstileForForm(llForm, submitButton, cfTurnstileSiteKey);
        } else {
          console.warn('Cloudflare Turnstile script not found in page. Please include the Turnstile script.');
        }
      }
    });
  }
});

/**
 * Initializes Google reCAPTCHA v2 widget for a specific form
 */
function initializeGoogleRecaptchaForForm(form, submitButton, googleRecaptchaV2SiteKey, googleRecaptchaV2Size) {
  // Validate required parameters
  if (!googleRecaptchaV2SiteKey || !googleRecaptchaV2Size) return;

  // Create a unique container element for this form's reCAPTCHA widget
  submitButton.insertAdjacentHTML(
    'beforebegin',
    `
    <div id="ll-g-recaptcha-${form.id}"></div>
  `
  );

  // Get reference to the created container
  const container = document.getElementById(`ll-g-recaptcha-${form.id}`);
  if (!container) return;

  // Setup retry mechanism for library loading
  let attempts = 0;
  const maxAttempts = 50; // Try for 5 seconds (50 * 100ms)

  /**
   * Internal function to check if reCAPTCHA library is loaded and render the widget
   * Uses recursive setTimeout to retry until library is available or timeout occurs
   */
  const checkAndRenderRecaptcha = () => {
    // Check if Google reCAPTCHA library is ready
    if (window.grecaptcha?.render) {
      try {
        // Clear any existing content in container
        container.innerHTML = '';

        // Render the reCAPTCHA widget
        const widgetId = window.grecaptcha.render(container, {
          sitekey: googleRecaptchaV2SiteKey,
          callback: `enableFormSubmitBtn${form.id}`, // Callback function name
          size: googleRecaptchaV2Size,
        });

        // Auto-execute invisible reCAPTCHA after a short delay
        if (googleRecaptchaV2Size === 'invisible') {
          setTimeout(() => window.grecaptcha?.execute(widgetId), 250);
        }
      } catch (error) {
        console.error('reCAPTCHA render error:', error);
      }
      return;
    }

    // Keep trying until library loads or timeout
    attempts++;
    if (attempts < maxAttempts) {
      setTimeout(checkAndRenderRecaptcha, 100);
    } else {
      console.warn('reCAPTCHA library failed to load after 5 seconds');
    }
  };

  // Start the loading check process
  checkAndRenderRecaptcha();
}

/**
 * Initializes Cloudflare Turnstile widget for a specific form
 */
function initializeCloudflareTurnstileForForm(form, submitButton, cfTurnstileSiteKey) {
  // Validate required parameter
  if (!cfTurnstileSiteKey) return;

  // Create a unique container element for this form's Turnstile widget
  submitButton.insertAdjacentHTML(
    'beforebegin',
    `
    <div id="ll-cf-turnstile-${form.id}"></div>
  `
  );

  // Get reference to the created container
  const container = document.getElementById(`ll-cf-turnstile-${form.id}`);
  if (!container) return;

  // Setup retry mechanism for library loading
  let attempts = 0;
  const maxAttempts = 50; // Try for 5 seconds (50 * 100ms)

  /**
   * Internal function to check if Turnstile library is loaded and render the widget
   * Uses recursive setTimeout to retry until library is available or timeout occurs
   */
  const checkAndRenderTurnstile = () => {
    // Check if Cloudflare Turnstile library is ready
    if (window.turnstile?.render) {
      try {
        // Clear any existing content in container
        container.innerHTML = '';

        // Render the Turnstile widget
        window.turnstile.render(container, {
          sitekey: cfTurnstileSiteKey,
          callback: enableFormSubmitButton.bind(null, submitButton), // Bound callback function
          theme: 'light',
          size: 'flexible',
        });
      } catch (error) {
        console.error('Turnstile render error:', error);
      }
      return;
    }

    // Keep trying until library loads or timeout
    attempts++;
    if (attempts < maxAttempts) {
      setTimeout(checkAndRenderTurnstile, 100);
    } else {
      console.warn('Turnstile library failed to load after 5 seconds');
    }
  };

  // Start the loading check process
  checkAndRenderTurnstile();
}

/**
 * Creates a dynamic callback function for each form that enables the submit button
 * when CAPTCHA validation is completed. This is specifically for Google reCAPTCHA
 * which requires string-based callback names.
 */
function createFormCaptchaCallback(formId) {
  // Create a unique global function name for this form
  window[`enableFormSubmitBtn${formId}`] = function () {
    // Find the form by its ID
    const form = document.getElementById(formId);
    if (form) {
      // Find the submit button within the form
      const submitButton = form.querySelector('button[type="submit"]');
      if (submitButton) {
        // Enable the submit button
        enableFormSubmitButton(submitButton);
      }
    }
  };
}

/**
 * Enables a form's submit button by removing the disabled attribute
 * This function is called after successful CAPTCHA validation
 */
function enableFormSubmitButton(submitButton) {
  if (submitButton) {
    submitButton.removeAttribute('disabled');
  }
}

/* ===================================================== */
/* ------------------- HELPERS ------------------------- */
/* ===================================================== */
function isInsideApp() {
  const hostname = window.location.hostname;
  return hostname === 'app.landerlab.io' || hostname === 'localhost';
}

function isPreview() {
  const hostname = window.location.hostname;
  return hostname === 'preview.landerlabpages.com';
}

function getCookie(name) {
  const match = document.cookie.match(new RegExp('(?:^|; )' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '=([^;]*)'));
  return match ? decodeURIComponent(match[1]) : null;
}

function setCookie(name, value, days) {
  document.cookie = name + '=' + encodeURIComponent(value) + '; max-age=' + (days * 86400) + '; path=/; SameSite=Lax';
}

/* ===================================================== */
/* -----------NEW NAVBAR COMPONENT SCRIPT -------------- */
/* ===================================================== */
(function() {
  'use strict';
  
  const MOBILE_BREAKPOINT = 992;
  const nav = document.querySelector('[data-gjs-type="nav"]');
  const toggle = document.querySelector('[data-gjs-type="nav-toggle"]');
  
  if (!nav || !toggle) {
    console.warn('Navigation elements not found');
    return;
  }
  
  const isExpanded = () => nav.dataset.expanded === 'true';
  
  const setExpanded = (value) => {
    nav.dataset.expanded = value;
    toggle.setAttribute('aria-expanded', value);
    document.body.style.overflow = value === 'true' ? 'hidden' : '';
  };
  
  const toggleMenu = () => setExpanded(!isExpanded());
  const closeMenu = () => setExpanded('false');
  
  // Event listeners
  toggle.addEventListener('click', toggleMenu);
  
  nav.addEventListener('click', (e) => {
    if (e.target.classList.contains('ll-nav__overlay') || 
        e.target.closest('[data-gjs-type="nav-links"] a, [data-gjs-type="nav-links"] button')) {
      closeMenu();
    }
  });
  
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isExpanded()) {
      closeMenu();
    }
  });
  
  let resizeTimeout;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(() => {
      if (window.innerWidth > MOBILE_BREAKPOINT && isExpanded()) {
        closeMenu();
      }
    }, 100);
  });
})();

/* ===================================================== */
/* ---------NEW ACCORDION COMPONENT SCRIPT ------------- */
/* ===================================================== */
(function() {
  'use strict';
  
  const accordions = document.querySelectorAll('[data-gjs-type="accordion"]');
  
  if (!accordions.length) {
    return;
  }
  
  accordions.forEach(accordion => {
    const headers = accordion.querySelectorAll('[data-accordion-header]');
    const allowMultiple = accordion.hasAttribute('data-allow-multiple');
    
    headers.forEach(header => {
      header.addEventListener('click', function() {
        const item = this.closest('[data-accordion-item]');
        const isOpen = item.dataset.open === 'true';
        
        if (allowMultiple) {
          // Allow multiple items open - just toggle this item
          item.dataset.open = isOpen ? 'false' : 'true';
        } else {
          // Close all items in this accordion
          accordion.querySelectorAll('[data-accordion-item]').forEach(i => {
            i.dataset.open = 'false';
          });
          
          // Open clicked item if it was closed
          if (!isOpen) {
            item.dataset.open = 'true';
          }
        }
      });
    });
  });
})();

/* ===================================================== */
/* ---------AI CREATED FORM SUBMIT SCRIPT -------------- */
/* ===================================================== */
document.addEventListener('ll-custom-form-submit', async (event) => {
  const formData = event.detail;
  
  if (isInsideApp()) {
    return;
  }
  
  // Collect tracking values
  const trustedFormCertUrl = document.querySelector('[name="xxTrustedFormCertUrl"]')?.value || '';
  const jornayaLeadId = window.LeadiD?.token || '';
  const clickFlareClickId = window.clickflare?.tracking_params?.click_id || '';
  
  // Get recaptcha score if enabled (with error handling)
  let recaptchaScore = '';
  if (window.RECAPTCHA_V3_SITE_KEY && window.grecaptcha) {
    try {
      recaptchaScore = await new Promise(resolve => {
        grecaptcha.ready(() => {
          grecaptcha.execute(window.RECAPTCHA_V3_SITE_KEY, {action: 'submit'}).then(resolve).catch(() => resolve(''));
        });
      });
    } catch {
      // silently continue
    }
  }
  
  const payload = {
    formToken: crypto.randomUUID(),
    variantId: window.LL_VARIANT_ID,
    landerId: window.LL_LANDER_ID,
    userId: window.LL_USER_ID,
    data: Object.entries(formData).map(([key, value]) => ({
      key,
      value,
      label: key
    }))
  };
  
  // Append tracking data
  if (clickFlareClickId) payload.data.push({ key: crypto.randomUUID(), value: clickFlareClickId, label: 'ClickFlare Click Id' });
  if (trustedFormCertUrl) payload.data.push({ key: crypto.randomUUID(), value: trustedFormCertUrl, label: 'Trusted Form Cert Url' });
  if (jornayaLeadId) payload.data.push({ key: crypto.randomUUID(), value: jornayaLeadId, label: 'Jornaya Lead Id' });
  if (recaptchaScore) payload.data.push({ key: crypto.randomUUID(), value: recaptchaScore, label: 'Recaptcha V3 Score' });
  
  try {
    const response = await fetch(
      'https://backend-v2.landerlab.workers.dev/api/v2/leads/create',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      }
    );
    
    const result = await response.json();
  } catch (error) {
    console.error('Failed to create lead:', error);
  }
});

/* ===================================================== */
/* ------------ NEW Newsletter Submit Script ----------- */
/* ===================================================== */
(function () {
  'use strict';

  // Find all newsletter forms on the page
  const newsletters = document.querySelectorAll('[data-gjs-type="ll-newsletter"]');
  if (!newsletters.length) {
    return;
  }

  // SVG icons for button states
  const loaderIcon = `<span class="ll-newsletter-loader"><svg xmlns="http://www.w3.org/2000/svg" width="1.5em" height="1.5em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg></span>`;
  const checkIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="1.5em" height="1.5em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>`;

  // Inject spinner animation styles
  const style = document.createElement('style');
  style.textContent = `
    @keyframes ll-newsletter-spin { to { transform: rotate(360deg); } }
    .ll-newsletter-loader { 
      display: inline-flex;
      animation: ll-newsletter-spin 1s linear infinite; 
    }
  `;
  document.head.appendChild(style);

  newsletters.forEach(form => {
    form.addEventListener('submit', async function (e) {
      e.preventDefault();

      if (isInsideApp()) {
        return;
      }

      // Cache DOM elements and initial state
      const button = this.querySelector('button');
      const input = this.querySelector('input');
      const originalContent = button.innerHTML;
      const redirectUrl = this.dataset.redirectUrl;
      const redirectTarget = this.dataset.redirectTarget || '_self';

      // Store button dimensions to prevent layout shift during state changes
      const buttonWidth = button.offsetWidth;
      const buttonHeight = button.offsetHeight;

      // Enter loading state - show spinner and disable inputs
      button.style.width = buttonWidth + 'px';
      button.style.height = buttonHeight + 'px';
      button.innerHTML = loaderIcon;
      button.disabled = true;
      input.disabled = true;

      try {
        // Build the lead payload
        const payload = {
          formToken: this.getAttribute('data-newsletter-id'),
          variantId: window.LL_VARIANT_ID,
          landerId: window.LL_LANDER_ID,
          userId: window.LL_USER_ID,
          data: [
            {
              key: input.id,
              value: input.value,
              label: input.name,
            }
          ],
        };

        // Submit to backend with minimum 1.5s delay to prevent jarring UI flashes
        const [response] = await Promise.all([
          fetch(
            'https://backend-v2.landerlab.workers.dev/api/v2/leads/create',
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload),
            }
          ),
          new Promise(resolve => setTimeout(resolve, 1500)),
        ]);

        if (!response.ok) throw new Error('Request failed');
      } catch (error) {
        console.error('[Newsletter] Failed:', error);
      } finally {
        // Show success checkmark
        button.innerHTML = checkIcon;

        // Hold success state for 2.5s
        await new Promise(resolve => setTimeout(resolve, 2500));

        // Handle redirect if configured
        if (redirectUrl) {
          if (redirectTarget === '_blank') {
            window.open(redirectUrl, '_blank');
          } else {
            window.location.href = redirectUrl;
          }
        }

        // Clear input
        input.value = '';

        // Reset button to original state
        button.innerHTML = originalContent;
        button.style.width = '';
        button.style.height = '';
        button.disabled = false;
        input.disabled = false;
      }
    });
  });
})();

/* ===================================================== */
/* -- ------ NEW COUNTDOWN COMPONENT SCRIPT --- -------- */
/* ===================================================== */
(function () {
  "use strict";

  const countdowns = document.querySelectorAll('[data-gjs-type="llcountdown"]');
  if (!countdowns.length) return;

  countdowns.forEach(function (countdown, index) {
    if (!countdown.dataset.id) {
      countdown.dataset.id = "ll_cd_" + index;
    }

    const mode = countdown.dataset.mode || "date";

    // Read which items exist directly from the HTML
    const order = ["days", "hours", "minutes", "seconds"];
    const items = {};
    const present = {};

    order.forEach(function (key) {
      const el = countdown.querySelector('[data-countdown-item="' + key + '"]');
      if (el) {
        items[key] = el;
        present[key] = el.dataset.hidden !== "true";
      }
    });

    // Calculate the target timestamp based on mode
    let targetDate;

    if (mode === "evergreen") {
      let durationSec = 0;
      order.forEach(function (key) {
        if (!present[key]) return;
        const valueEl = items[key].querySelector("[data-countdown-value]");
        const val = parseInt(valueEl.textContent, 10) || 0;
        if (key === "days") durationSec += val * 86400;
        if (key === "hours") durationSec += val * 3600;
        if (key === "minutes") durationSec += val * 60;
        if (key === "seconds") durationSec += val;
      });

      const cookieName = "ll_cd_" + (countdown.dataset.id || "default");
      const preview = isPreview();
      const stored = preview ? null : getCookie(cookieName);
      let startTime;

      if (stored) {
        startTime = parseInt(stored, 10);
      } else {
        startTime = Date.now();
        if (!preview) {
          setCookie(cookieName, String(startTime), durationSec);
        }
      }

      targetDate = startTime + durationSec * 1000;
    } else {
      targetDate = new Date(
        countdown.dataset.date.replace(/\s/g, ""),
      ).getTime();
    }

    // Countdown tick — runs once per second
    function tick() {
      const now = Date.now();
      const diff = Math.max(0, targetDate - now);
      let totalSeconds = Math.floor(diff / 1000);

      const values = {};

      if (present.days) {
        values.days = Math.floor(totalSeconds / 86400);
        totalSeconds %= 86400;
      }

      if (present.hours) {
        values.hours = Math.floor(totalSeconds / 3600);
        totalSeconds %= 3600;
      }

      if (present.minutes) {
        values.minutes = Math.floor(totalSeconds / 60);
        totalSeconds %= 60;
      }

      if (present.seconds) {
        values.seconds = totalSeconds;
      }

      order.forEach(function (key) {
        if (!present[key]) return;
        const valueEl = items[key].querySelector("[data-countdown-value]");
        if (valueEl) {
          valueEl.textContent = String(values[key]).padStart(2, "0");
        }
      });

      if (diff <= 0) {
        clearInterval(interval);

        if (!countdown._llCountdownEnded) {
          countdown._llCountdownEnded = true;
          countdown.dispatchEvent(
            new CustomEvent("ll-countdown-end", {
              bubbles: true,
              detail: { id: countdown.dataset.id, mode: mode },
            }),
          );

          const redirectUrl = countdown.dataset.redirectUrl;
          if (redirectUrl) {
            const target = countdown.dataset.redirectTarget || "_self";
            if (target === "_self") {
              window.location.href = redirectUrl;
            } else {
              window.open(redirectUrl, "_blank");
            }
          }
        }
      }
    }

    tick();
    const interval = setInterval(tick, 1000);
  });
})();

/* ===================================================== */
/* ------- NEW STICKY BAR COMPONENT SCRIPT ------------- */
/* ===================================================== */
(function () {
  'use strict';

  const SELECTOR = '[data-gjs-type="llstickybar"]';

  // ─── Get bar ID ──────────────────────────────────────────
  function getBarId(bar) {
    return bar.id || null;
  }

  // ─── Resolve bars by optional ID ─────────────────────────
  function resolveBars(barId) {
    if (barId) {
      const el = document.querySelector(SELECTOR + '#' + barId);
      return el ? [el] : [];
    }
    return Array.from(document.querySelectorAll(SELECTOR));
  }

  // ─── Responsive scroll threshold ─────────────────────────
  function getScrollDistance(bar, isPercent) {
    const w = window.innerWidth;
    const d = bar.dataset;
    let value;

    if (w < 576 && d.scrollDistanceMobile) {
      value = parseFloat(d.scrollDistanceMobile) || 0;
    } else if (w < 992 && d.scrollDistanceTablet) {
      value = parseFloat(d.scrollDistanceTablet) || 0;
    } else {
      value = parseFloat(d.scrollDistance) || 0;
    }

    if (isPercent) {
      const scrollable = document.documentElement.scrollHeight - window.innerHeight;
      if (scrollable <= 0) return 0;
      return Math.round((value / 100) * scrollable);
    }

    return Math.round(value);
  }

  // ─── Core visibility functions ───────────────────────────
  function showBar(bar) {
    if (bar.dataset.dismissed === 'true') return;
    bar.style.display = 'block';
    bar.dataset.visible = 'true';
  }

  function hideBar(bar) {
    bar.dataset.visible = 'false';

    if (bar.dataset.animation === 'none') {
      bar.style.display = 'none';
    } else {
      bar.addEventListener('transitionend', function onEnd() {
        bar.style.display = 'none';
        bar.removeEventListener('transitionend', onEnd);
      });
    }
  }

  function dismissBar(bar) {
    bar.dataset.dismissed = 'true';
    bar.dataset.visible = 'false';

    const stayDismissed = bar.dataset.stayDismissed === 'true';
    const barId = getBarId(bar);
    const cookieName = barId ? 'll_sb_' + barId : null;

    if (stayDismissed && cookieName && !isPreview()) setCookie(cookieName, '1', 30);

    if (bar.dataset.animation === 'none') {
      bar.style.display = 'none';
    } else {
      bar.addEventListener('transitionend', function onEnd() {
        bar.style.display = 'none';
        bar.removeEventListener('transitionend', onEnd);
      });
    }
  }

  function toggleBar(bar) {
    if (bar.dataset.visible === 'true') {
      hideBar(bar);
    } else {
      showBar(bar);
    }
  }

  // ─── Public API ──────────────────────────────────────────
  window.llStickyBars = {
    show: function (barId) { resolveBars(barId).forEach(showBar); },
    hide: function (barId) { resolveBars(barId).forEach(hideBar); },
    dismiss: function (barId) { resolveBars(barId).forEach(dismissBar); },
    toggle: function (barId) { resolveBars(barId).forEach(toggleBar); },
    get: function (barId) {
      const bars = resolveBars(barId);
      return barId ? bars[0] || null : bars;
    }
  };

  // ─── Auto-init each bar ──────────────────────────────────
  const bars = document.querySelectorAll(SELECTOR);
  if (!bars.length) return;

  bars.forEach(function (bar) {
    const d = bar.dataset;
    const showOn = d.showOn || 'load';
    const stayDismissed = d.stayDismissed === 'true';
    const barId = getBarId(bar);
    const cookieName = barId ? 'll_sb_' + barId : null;

    // Already dismissed via cookie — bail out
    if (stayDismissed && cookieName && !isPreview() && getCookie(cookieName) === '1') {
      bar.style.display = 'none';
      return;
    }

    // Close button
    const closeBtn = bar.querySelector('[data-sticky-bar-close]');
    if (closeBtn) closeBtn.addEventListener('click', function () { dismissBar(bar); });

    // No animation on load — already visible via CSS
    if (showOn === 'load' && (d.animation || 'slide') === 'none') return;

    bar.dataset.visible = 'false';

    // Trigger visibility based on show condition
    if (showOn === 'load') {
      requestAnimationFrame(function () { requestAnimationFrame(function () { showBar(bar); }); });
    } else if (showOn === 'delay') {
      setTimeout(function () { showBar(bar); }, (parseFloat(d.delay) || 0) * 1000);
    } else if (showOn === 'scroll' || showOn === 'scroll-percent') {
      const isPercent = showOn === 'scroll-percent';
      function onScroll() {
        const threshold = getScrollDistance(bar, isPercent);
        if (window.scrollY >= threshold) {
          showBar(bar);
          window.removeEventListener('scroll', onScroll);
        }
      }
      window.addEventListener('scroll', onScroll, { passive: true });
    }
  });
})();
/* ===================================================== */
/* ---------- TRUSTED FORM HELPER SCRIPT --------------- */
/* ===================================================== */
(function () {
  'use strict';
  if (document.getElementById('tf-hidden-form')) return;

  const form = document.createElement('form');
  form.style.cssText = 'display:none!important';
  form.id = 'tf-hidden-form';
  document.body.appendChild(form);
})();

/* ===================================================== */
/* -------- TRUSTED FORM QUIZ SUBMIT TRIGGER ----------- */
/* ===================================================== */
window.addEventListener('ll-quiz-submit', function (event) {
  const tfForm = document.getElementById('tf-hidden-form');
  if (tfForm) {
    const submitEvent = new Event('submit', { bubbles: true, cancelable: true });
    tfForm.dispatchEvent(submitEvent);
  }
});

/* ===================================================== */
/* --------- STYLE MANAGER ANIMATION SCRIPT ------------ */
/* ===================================================== */
(function () {
  /* Based on https://animate.style/ documentation */
  'use strict';

  const SCROLL_PLAY_DELAY = 150; // ms delay after element enters viewport before playing

  const ENTRANCE_PRESETS = [
    'backInDown', 'backInLeft', 'backInRight', 'backInUp',
    'bounceIn', 'bounceInDown', 'bounceInLeft', 'bounceInRight', 'bounceInUp',
    'fadeIn', 'fadeInDown', 'fadeInDownBig', 'fadeInLeft', 'fadeInLeftBig',
    'fadeInRight', 'fadeInRightBig', 'fadeInUp', 'fadeInUpBig',
    'fadeInTopLeft', 'fadeInTopRight', 'fadeInBottomLeft', 'fadeInBottomRight',
    'flipInX', 'flipInY',
    'lightSpeedInRight', 'lightSpeedInLeft',
    'rotateIn', 'rotateInDownLeft', 'rotateInDownRight', 'rotateInUpLeft', 'rotateInUpRight',
    'zoomIn', 'zoomInDown', 'zoomInLeft', 'zoomInRight', 'zoomInUp',
    'slideInDown', 'slideInLeft', 'slideInRight', 'slideInUp'
  ];

  const SPEED_MAP = {
    slower: 'animate__slower',
    slow: 'animate__slow',
    'default': '',
    fast: 'animate__fast',
    faster: 'animate__faster'
  };

  const DELAY_MAP = {
    none: '',
    '1s': 'animate__delay-1s',
    '2s': 'animate__delay-2s',
    '3s': 'animate__delay-3s',
    '4s': 'animate__delay-4s',
    '5s': 'animate__delay-5s'
  };

  const REPEAT_MAP = {
    '1': '',
    '2': 'animate__repeat-2',
    '3': 'animate__repeat-3',
    infinite: 'animate__infinite'
  };

  const isEntrance = (preset) => ENTRANCE_PRESETS.indexOf(preset) !== -1;

  const getClasses = (anim) => {
    const classes = ['animate__animated', 'animate__' + anim.preset];
    const speed = SPEED_MAP[anim.speed || 'default'];
    const delay = DELAY_MAP[anim.delay || 'none'];
    const repeat = REPEAT_MAP[anim.repeat || '1'];
    if (speed) classes.push(speed);
    if (delay) classes.push(delay);
    if (repeat) classes.push(repeat);
    return classes;
  };

  const playAnimation = (el, anim) => {
    el.style.visibility = '';
    el.style.opacity = '';
    const classes = getClasses(anim);
    classes.forEach((c) => el.classList.remove(c));
    void el.offsetHeight;
    classes.forEach((c) => el.classList.add(c));

    el.addEventListener('animationend', function handler() {
      if (anim.repeat !== 'infinite') {
        classes.forEach((c) => el.classList.remove(c));
      }
      el.removeEventListener('animationend', handler);
    });
  };

  const setupAnimation = (el, anim, scrollEntries) => {
    const trigger = anim.trigger || 'scroll';

    switch (trigger) {
      case 'scroll': {
        const existing = scrollEntries.find((s) => s.el === el);
        if (existing) {
          existing.anims.push(anim);
        } else {
          scrollEntries.push({ el, anims: [anim] });
        }
        break;
      }

      case 'hover':
        el.addEventListener('mouseenter', () => playAnimation(el, anim));
        break;

      case 'click':
        el.addEventListener('click', () => playAnimation(el, anim));
        break;

      case 'load':
        playAnimation(el, anim);
        break;
    }
  };

  const initAnimations = () => {
    const elements = document.querySelectorAll('[data-ll-animations]');
    const scrollEntries = [];

    elements.forEach((el) => {
      const raw = el.getAttribute('data-ll-animations');
      if (!raw) return;

      let animations;
      try { animations = JSON.parse(raw); } catch (e) { return; }
      if (!Array.isArray(animations) || animations.length === 0) return;

      const hasEntrance = animations.some((anim) =>
        isEntrance(anim.preset) && (anim.trigger === 'scroll' || anim.trigger === 'load')
      );
      if (hasEntrance) {
        el.style.visibility = 'hidden';
        el.style.opacity = '0';
      }

      animations.forEach((anim) => {
        if (!anim.preset || anim.preset === 'none') return;
        setupAnimation(el, anim, scrollEntries);
      });
    });

    if (scrollEntries.length > 0) {
      const observer = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            if (entry.isIntersecting) {
              const data = scrollEntries.find((s) => s.el === entry.target);
              if (data) {
                setTimeout(() => {
                  data.anims.forEach((anim) => playAnimation(entry.target, anim));
                }, SCROLL_PLAY_DELAY);
              }
              observer.unobserve(entry.target);
            }
          });
        },
        { threshold: 0.15 }
      );

      scrollEntries.forEach((data) => observer.observe(data.el));
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAnimations);
  } else {
    initAnimations();
  }
})();