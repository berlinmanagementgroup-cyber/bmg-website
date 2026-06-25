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
        // Push form_submission_success to dataLayer for GTM AJAX backup trigger
        window.dataLayer = window.dataLayer || [];
        window.dataLayer.push({
          event: "form_submission_success",
          form_name: "ops_audit_form",
          form_industry: formIndustry
        });

        // Success - redirect to custom thank-you page
        window.location.href = "/thank-you.html";
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
