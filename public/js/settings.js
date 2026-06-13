(function initSettingsModule() {
  const storeDomainInput = document.getElementById("storeDomain");
  const accessTokenInput = document.getElementById("accessToken");
  const tokenHint = document.getElementById("tokenHint");
  const saveConnectionBtn = document.getElementById("saveConnectionBtn");
  const saveRulesBtn = document.getElementById("saveRulesBtn");
  const testConnectionBtn = document.getElementById("testConnectionBtn");
  const connectionMessage = document.getElementById("connectionMessage");
  const rulesMessage = document.getElementById("rulesMessage");
  const configPathHint = document.getElementById("configPathHint");

  const ruleFields = {
    product: ["imageFilename", "imageAlt", "seoTitle", "seoDescription", "tags"],
    collection: ["imageFilename", "imageAlt", "seoTitle", "seoDescription"],
    article: ["imageFilename", "imageAlt", "seoTitle", "seoDescription", "tags"],
  };

  function readRulesFromForm() {
    const rules = { product: {}, collection: {}, article: {} };
    for (const [type, fields] of Object.entries(ruleFields)) {
      for (const field of fields) {
        const el = document.getElementById(`rule-${type}-${field}`);
        if (el) {
          rules[type][field] = el.value;
        }
      }
    }
    return rules;
  }

  function fillRulesForm(rules) {
    for (const [type, fields] of Object.entries(ruleFields)) {
      for (const field of fields) {
        const el = document.getElementById(`rule-${type}-${field}`);
        if (el && rules?.[type]?.[field] != null) {
          el.value = rules[type][field];
        }
      }
    }
  }

  function applySettings(data) {
    storeDomainInput.value = data.shopify.storeDomain || "";
    tokenHint.textContent = data.shopify.hasToken
      ? `Saved token: ${data.shopify.accessTokenMasked}`
      : "No token saved yet.";
    configPathHint.textContent = data.configPath
      ? `Credentials stored locally at ${data.configPath}`
      : "";
    fillRulesForm(data.rules);
    window.EditProSettings = {
      rules: data.rules,
      shopName: data.shopName || "",
      storeDomain: data.shopify.storeDomain || "",
      connected: Boolean(data.shopify.hasToken && data.shopify.storeDomain),
    };
  }

  async function loadSettings() {
    try {
      const data = await EditProUtils.apiGet("/api/settings");
      applySettings(data);
      document.dispatchEvent(new CustomEvent("editpro:settings-loaded"));
    } catch (error) {
      EditProUtils.showMessage(connectionMessage, error.message, "error");
    }
  }

  async function saveConnection() {
    EditProUtils.hideMessage(connectionMessage);
    saveConnectionBtn.disabled = true;
    saveConnectionBtn.textContent = "Saving…";

    try {
      const data = await EditProUtils.apiPost("/api/settings", {
        shopify: {
          storeDomain: storeDomainInput.value.trim(),
          accessToken: accessTokenInput.value.trim(),
        },
        rules: readRulesFromForm(),
      });
      accessTokenInput.value = "";
      applySettings(data);
      document.dispatchEvent(new CustomEvent("editpro:settings-saved"));
      EditProUtils.showMessage(connectionMessage, "Connection saved.", "success");
    } catch (error) {
      EditProUtils.showMessage(connectionMessage, error.message, "error");
    } finally {
      saveConnectionBtn.disabled = false;
      saveConnectionBtn.textContent = "Save connection";
    }
  }

  async function saveRules() {
    EditProUtils.hideMessage(rulesMessage);
    saveRulesBtn.disabled = true;
    saveRulesBtn.textContent = "Saving…";

    try {
      const data = await EditProUtils.apiPost("/api/settings", {
        shopify: {
          storeDomain: storeDomainInput.value.trim(),
          accessToken: "",
        },
        rules: readRulesFromForm(),
      });
      applySettings(data);
      document.dispatchEvent(new CustomEvent("editpro:settings-saved"));
      EditProUtils.showMessage(rulesMessage, "Rules saved.", "success");
    } catch (error) {
      EditProUtils.showMessage(rulesMessage, error.message, "error");
    } finally {
      saveRulesBtn.disabled = false;
      saveRulesBtn.textContent = "Save rules";
    }
  }

  async function testConnection() {
    EditProUtils.hideMessage(connectionMessage);
    testConnectionBtn.disabled = true;
    testConnectionBtn.textContent = "Testing…";

    try {
      if (accessTokenInput.value.trim() || storeDomainInput.value.trim()) {
        await EditProUtils.apiPost("/api/settings", {
          shopify: {
            storeDomain: storeDomainInput.value.trim(),
            accessToken: accessTokenInput.value.trim(),
          },
          rules: readRulesFromForm(),
        });
      }
      const result = await EditProShopify.testConnection();
      window.EditProSettings = window.EditProSettings || {};
      window.EditProSettings.shopName = result.shop?.name || "";
      window.EditProSettings.storeDomain = result.shop?.myshopifyDomain || storeDomainInput.value.trim();
      window.EditProSettings.connected = true;

      let message = `Connected to ${result.shop.name} (${result.shop.myshopifyDomain}).`;
      let type = "success";
      try {
        await EditProShopify.graphql(
          `query ContentAccessCheck { articles(first: 1) { nodes { id } } }`
        );
        window.EditProSettings.contentAccess = true;
      } catch (error) {
        if (EditProUtils.isAccessDeniedError(error.message)) {
          window.EditProSettings.contentAccess = false;
          message +=
            " Blog articles need read_content and write_content scopes. Products and collections will still work.";
          type = "warning";
        }
      }

      document.dispatchEvent(new CustomEvent("editpro:settings-saved"));
      EditProUtils.showMessage(connectionMessage, message, type);
    } catch (error) {
      EditProUtils.showMessage(connectionMessage, error.message, "error");
    } finally {
      testConnectionBtn.disabled = false;
      testConnectionBtn.textContent = "Test connection";
    }
  }

  saveConnectionBtn?.addEventListener("click", saveConnection);
  saveRulesBtn?.addEventListener("click", saveRules);
  testConnectionBtn?.addEventListener("click", testConnection);
  loadSettings();
})();
