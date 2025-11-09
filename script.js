function setManifest() {
    var sel = document.getElementById('ver');
    var opt = sel.options[sel.selectedIndex];
    var m = opt.dataset.manifest;
    var me = opt.dataset.ethernet;
    var ma = opt.dataset.audio;
    var mt = opt.dataset.test;
    var mv4 = opt.dataset.v4;
    var mdebug = opt.dataset.debug;

    //handle ethernet checkbox
    m = handleCheckbox(m, me, 'ethernet');
    //handle audioreactive checkbox
    m = handleCheckbox(m, ma, 'audio');
    //handle audioreactive checkbox
    m = handleCheckbox(m, mt, 'test');
    //handle v4 checkbox
    m = handleCheckbox(m, mv4, 'v4');
    //handle debug checkbox
    m = handleCheckbox(m, mdebug, 'debug');

    document.getElementById('inst').setAttribute('manifest', m);
    document.getElementById('verstr').textContent = opt.text;
}



function handleCheckbox(manifest, checkboxmanifest, primaryCheckbox) {
    //Check if specified manifest is available

    if (!checkboxmanifest) {
        document.getElementById(primaryCheckbox).disabled = true;
        document.getElementById(primaryCheckbox + "_label").classList.remove("radio__label");
        document.getElementById(primaryCheckbox + "_label").classList.add("disabled__label");
    } else {
        document.getElementById(primaryCheckbox + "_label").classList.remove("disabled__label");
        document.getElementById(primaryCheckbox + "_label").classList.add("radio__label");
    }


    if (checkboxmanifest && document.getElementById(primaryCheckbox).checked) {
        manifest = checkboxmanifest;
    }
    return manifest;
}

function resetCheckboxes() {
    document.getElementById('ethernet').checked = false;
    document.getElementById('ethernet').disabled = false;
    document.getElementById('audio').checked = false;
    document.getElementById('audio').disabled = false;
    document.getElementById('test').checked = false;
    document.getElementById('test').disabled = false;
    document.getElementById('v4').checked = false;
    document.getElementById('v4').disabled = false;
    document.getElementById('debug').checked = false;
    document.getElementById('debug').disabled = false;
}

function checkSupported() {
    if (document.getElementById('inst').hasAttribute('install-unsupported')) unsupported();
    else setManifest();
}

function unsupported() {
    document.getElementById('flasher').innerHTML = `Sorry, your browser is not yet supported!<br>
    Please try on Desktop Chrome or Edge.<br>
    Find binary files here:<br>
    <a href="https://github.com/Aircoookie/WLED/releases" target="_blank">
    <button class="btn" slot="activate">GitHub Releases</button>
    </a>`
}

function showSerialHelp() {
    document.getElementById('coms').innerHTML = `Hit "Install" and select the correct COM port.<br><br>
    You might be missing the drivers for your board.<br>
    Here are drivers for chips commonly used in ESP boards:<br>
    <a href="https://www.silabs.com/developers/usb-to-uart-bridge-vcp-drivers" target="_blank">CP2102 (square chip)</a><br>
    <a href="https://github.com/nodemcu/nodemcu-devkit/tree/master/Drivers" target="_blank">CH34x (rectangular chip)</a><br><br>
    Make sure your USB cable supports data transfer.<br><br>
    `;
}
