// AJAX form submission handler for BMG contact form
// Submits to Formspree via fetch, pushes to dataLayer, and redirects to thank-you page
(function() {
  var form = document.getElementById("auditForm");
  if (!form) return;

  form.addEventListener("submit", function(e) {
    e.preventDefault();

    var data = new FormData(form);
    var btn = form.querySelector('button[type="submit"]');
    var originalText = btn ? btn.textContent : "";

    // Capture form field values for dataLayer
    var industrySelect = form.querySelector('#industry');
    var formIndustry = industrySelect ? industrySelect.value : "";

    // Show sending state
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Sending...";
    }

    // Submit via AJAX
    var xhr = new XMLHttpRequest();
    xhr.open("POST", form.action);
    xhr.setRequestHeader("Accept", "application/json");

    xhr.onreadystatechange = function() {
      if (xhr.readyState !== 4) return;

      if (xhr.status >= 200 && xhr.status < 300) {
        // Success - deliver the lead event to GTM, then navigate.
        // Redirect happens from the event callback (or the fallback), never immediately,
        // so navigation cannot cancel the in-flight GTM dispatch.
        var hasRedirected = false;
        var redirectToThankYou = function() {
          if (hasRedirected) return;
          hasRedirected = true;
          window.location.assign("/thank-you.html");
        };

        window.dataLayer = window.dataLayer || [];
        window.dataLayer.push({
          event: "form_submission_success",
          form_name: "ops_audit_form",
          form_industry: formIndustry,
          eventCallback: redirectToThankYou,
          eventTimeout: 2000
        });

        // Fallback when GTM is blocked, unavailable, or fails to invoke the callback.
        window.setTimeout(redirectToThankYou, 2100);
      } else {
        // Error - restore button and alert
        if (btn) {
          btn.disabled = false;
          btn.textContent = originalText;
        }
        alert("Something went wrong. Please try again or email us directly.");
      }
    };

    xhr.send(data);
  });

  // Fade-up animation observer - makes .fade-up elements visible on scroll
  document.addEventListener('DOMContentLoaded', function() {
      var observer = new IntersectionObserver(function(entries) {
            entries.forEach(function(entry) {
                    if (entry.isIntersecting) {
                              entry.target.classList.add('visible');
                              observer.unobserve(entry.target);
                    }
            });
      }, { threshold: 0.1 });
      document.querySelectorAll('.fade-up').forEach(function(el) {
            observer.observe(el);
      });
  });
})();
