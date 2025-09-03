function setManifest() {
    var sel = document.getElementById('ver');
    var opt = sel.options[sel.selectedIndex];
    var m = opt.dataset.manifest;
    var me = opt.dataset.ethernet;
    var ma = opt.dataset.audio;
    var mt = opt.dataset.test;

    //handle ethernet checkbox
    m = handleCheckbox(m, me, 'ethernet');
    //handle audioreactive checkbox
    m = handleCheckbox(m, ma, 'audio');
    //handle audioreactive checkbox
    m = handleCheckbox(m, mt, 'test');

    document.getElementById('inst').setAttribute('manifest', m);
    document.getElementById('verstr').textContent = opt.text;

    checkOS();
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
}

function checkSupported() {
    if (document.getElementById('inst').hasAttribute('install-unsupported')) unsupported();
    else setManifest();
}

function checkOS() {
    if (navigator.userAgent.includes("Linux")) {
        document.body.classList.add("linux");
    }
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
    document.getElementById('coms').innerHTML = `Hit "Install" and select the correct COM port. <a onclick="showPermissionHelp()" class="showOnLinux">Failed to open serial port?</a><br><br>
    <span class="showOnLinux">
    Your USB cable might not support data transfer.<br>
    To check if your cable supports data, connect the device and run:<br>
    <code>lsusb</code> &mdash; Look for CP210x/CH341<br><br>
    Missing drivers might also be the issue.<br>
    To check whether your kernel includes the right driver, run:<br>
    <code>zcat /proc/config.gz | grep -E "CP210X|CH341"</code><br>
    You should see:<br>
    <code>CONFIG_USB_SERIAL_CP210X=m</code> or <code>=y</code> &mdash; for CP2102 (square chip)<br>
    <code>CONFIG_USB_SERIAL_CH341=m</code> or <code>=y</code> &mdash; for CH34x (rectangular chip)<br>
    If not present or set to <code>=n</code>, you may need to recompile your kernel with these options enabled.<br><br>
    Note: Your device may appear as <code>ttyUSBX</code>.
    </span>
    <span class="hideOnLinux">
    You might be missing the drivers for your board.<br>
    Here are drivers for chips commonly used in ESP boards:<br>
    <a href="https://www.silabs.com/developers/usb-to-uart-bridge-vcp-drivers" target="_blank">CP2102 (square chip)</a><br>
    <a href="https://github.com/nodemcu/nodemcu-devkit/tree/master/Drivers" target="_blank">CH34x (rectangular chip)</a><br><br>
    Make sure your USB cable supports data transfer.
    </span>
    <br><br>
    `;
}

function showPermissionHelp() {
    document.getElementById('coms').innerHTML = `Hit "Install" and select the correct COM port. <a onclick="showSerialHelp()">No device found?</a><br><br>
    Your browser likely does not have the necessary permissions to access the connected ESP device.<br>
    To resolve this issue, add your user to the group that owns the device (typically <code>/dev/ttyUSB0)</code>:<br>
    <code>sudo usermod -aG "$(stat --format='%G' /dev/ttyUSB0)" "$USER"</code><br>
    After running the command, reboot for the changes to take effect.<br><br>
    `;
}