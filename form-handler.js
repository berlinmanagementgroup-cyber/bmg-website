// AJAX form submission handler for BMG contact form
// Submits to Formspree via fetch and redirects to custom thank-you page
// Includes dataLayer push for GTM conversion tracking (backup method)
(function() {
  var form = document.getElementById("auditForm");
  if (!form) return;

  form.addEventListener("submit", function(e) {
    e.preventDefault();

    var data = new FormData(form);
    var btn = form.querySelector('button[type="submit"]');
    var originalText = btn ? btn.textContent : "";

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
        // Push conversion event to dataLayer before redirect
        // GTM picks this up as a backup conversion signal
        window.dataLayer = window.dataLayer || [];
        window.dataLayer.push({
          event: "form_submission_success",
          form_name: "ops_audit_form",
          form_industry: (function() {
            var sel = form.querySelector("[name='industry']");
            return sel ? sel.value : "unknown";
          })()
        });

        // Brief delay to allow GTM to process before redirect
        setTimeout(function() {
          window.location.href = "/thank-you.html";
        }, 300);
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
})();
