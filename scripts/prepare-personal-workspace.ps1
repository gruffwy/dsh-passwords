param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string]$Directory,
    [Parameter(Mandatory = $true)][string]$BackupDirectory
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$rootItem = Get-Item -LiteralPath $Root -Force
$item = Get-Item -LiteralPath $Directory -Force
if (-not $rootItem.PSIsContainer -or -not $item.PSIsContainer -or
    ($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
    ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Personal workspace must be a real directory' }
$rootPath = [IO.Path]::GetFullPath($rootItem.FullName).TrimEnd('\')
$directoryPath = [IO.Path]::GetFullPath($item.FullName).TrimEnd('\')
if (-not [string]::Equals([IO.Path]::GetDirectoryName($directoryPath), $rootPath, [StringComparison]::OrdinalIgnoreCase) -or
    $item.Name -notmatch '^u_([1-9][0-9]*)$') { throw 'Personal workspace is outside its expected root' }
$expectedId = $Matches[1]
$marker = Get-Item -LiteralPath (Join-Path $directoryPath '.dsh-personal-workspace.json') -Force
if ($marker.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Personal workspace marker cannot be a link' }
$registration = Get-Content -LiteralPath $marker.FullName -Raw | ConvertFrom-Json
if ([string]$registration.userId -ne $expectedId) { throw 'Personal workspace ownership marker does not match' }

$identity = [Security.Principal.WindowsIdentity]::GetCurrent().User
$inheritance = [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
$fullControl = [Security.AccessControl.FileSystemRights]::FullControl
function HasHostGrant($descriptor) {
    foreach ($rule in $descriptor.GetAccessRules($true, $false, [Security.Principal.SecurityIdentifier])) {
        if ($rule.IdentityReference -eq $identity -and
            $rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
            ($rule.FileSystemRights -band $fullControl) -eq $fullControl -and
            ($rule.InheritanceFlags -band $inheritance) -eq $inheritance -and
            $rule.PropagationFlags -eq [Security.AccessControl.PropagationFlags]::None) { return $true }
    }
    return $false
}
$acl = Get-Acl -LiteralPath $directoryPath
if ($acl.GetOwner([Security.Principal.SecurityIdentifier]) -eq $identity -and (HasHostGrant $acl)) {
    Write-Output 'Personal workspace Windows permissions already prepared'
    exit 0
}
$sections = [Security.AccessControl.AccessControlSections]'Access,Owner,Group'
$previous = $acl.GetSecurityDescriptorSddlForm($sections)
New-Item -ItemType Directory -Path $BackupDirectory -Force | Out-Null
$backup = Join-Path $BackupDirectory ('u_' + $expectedId + '-' + [Guid]::NewGuid().ToString('N') + '.json')
@{ path = $directoryPath; sddl = $previous; hostSid = $identity.Value } | ConvertTo-Json |
    Set-Content -LiteralPath $backup -Encoding UTF8
try {
    $acl.SetOwner($identity)
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
        $identity, $fullControl, $inheritance, [Security.AccessControl.PropagationFlags]::None,
        [Security.AccessControl.AccessControlType]::Allow))
    Set-Acl -LiteralPath $directoryPath -AclObject $acl
    $verified = Get-Acl -LiteralPath $directoryPath
    if ($verified.GetOwner([Security.Principal.SecurityIdentifier]) -ne $identity -or -not (HasHostGrant $verified)) {
        throw 'Personal workspace Windows permission verification failed'
    }
    Write-Output ('Personal workspace Windows permissions prepared; backup: ' + $backup)
} catch {
    $failure = $_
    try {
        $restore = [Security.AccessControl.DirectorySecurity]::new()
        $restore.SetSecurityDescriptorSddlForm($previous, $sections)
        Set-Acl -LiteralPath $directoryPath -AclObject $restore
    } catch { throw ('Workspace permission repair failed and rollback needs review; backup: ' + $backup + '; ' + $_.Exception.Message) }
    throw $failure
}
