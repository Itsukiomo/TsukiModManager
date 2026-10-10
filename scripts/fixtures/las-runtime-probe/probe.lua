Hooks:Add("MenuManagerInitialize", "TsukiLASRuntimeProbe", function()
    local styles = tweak_data and tweak_data.blackmarket and tweak_data.blackmarket.player_styles
    local style = styles and styles.las_loona
    local count = 0
    if style and style.material_variations then
        for _ in pairs(style.material_variations) do count = count + 1 end
    end
    log("[TsukiLASProbe] BeardLib=" .. tostring(BeardLib ~= nil)
        .. " LAS=" .. tostring(LA_Skins ~= nil)
        .. " LoonaStyle=" .. tostring(style ~= nil)
        .. " Variations=" .. tostring(count))
end)
